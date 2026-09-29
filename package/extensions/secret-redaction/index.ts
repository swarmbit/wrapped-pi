/**
 * Reversible, best-effort redaction of model-visible credentials.
 * Local files, environment variables, and provider authentication are unchanged.
 * This is a privacy filter, not a sandbox or an exfiltration boundary.
 */
import * as path from "node:path";
import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionSecrets } from "./state";

const FAILURE = "Secret redaction failed. Content withheld; check the local secret-redaction directory permissions.";
const GUIDELINE = "Credential values may appear as __WPI_SECRET_...__ placeholders. Keep them unchanged when copying content or constructing tool arguments; local tools restore them automatically. Do not guess, decode, split, or transform placeholders. Prefer quoted environment-variable references in shell commands. Never reveal credentials.";

function reportFailure(ctx: ExtensionContext): void {
  // Pi swallows request-hook exceptions. Abort explicitly AND return a scrubbed
  // fallback from the caller, rather than allowing the original payload through.
  try { ctx.abort(); } catch { /* still withhold the content */ }
  try { if (ctx.hasUI) ctx.ui.notify(FAILURE, "error"); } catch { /* no logging of raw errors */ }
}

function protect<T>(ctx: ExtensionContext, operation: () => T, fallback: T): T {
  try { return operation(); } catch { reportFailure(ctx); return fallback; }
}

export default function secretRedaction(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    protect(ctx, () => { getSessionSecrets(ctx); }, undefined);
  });

  pi.on("input", (event, ctx) => {
    try {
      return { action: "transform", text: getSessionSecrets(ctx).redactor.redact(event.text), images: event.images };
    } catch {
      reportFailure(ctx);
      return { action: "handled" };
    }
  });

  pi.on("before_agent_start", (event, ctx) => protect(ctx, () => ({
    systemPrompt: getSessionSecrets(ctx).redactor.redact(event.systemPrompt) + "\n\n" + GUIDELINE,
  }), { systemPrompt: FAILURE }));

  pi.on("tool_call", (event, ctx) => {
    try {
      const session = getSessionSecrets(ctx);
      const restored = session.redactor.restore(event.input, event.toolName === "bash" || event.toolName === "powershell");
      // A subagent is another model, not a credential-consuming application. Keep
      // its task masked; its extension resolves the same persisted token records.
      if (event.toolName !== "subagent") Object.assign(event.input, restored);
      const filename = (restored as Record<string, unknown>).path ?? (restored as Record<string, unknown>).file_path;
      if (typeof filename === "string" && ["read", "edit", "write"].includes(event.toolName)) {
        session.scanFile(path.resolve(ctx.cwd, filename));
      }
    } catch (error) {
      // Our restoration errors contain no secret values. Other failures use a fixed message.
      const message = error instanceof Error && /^(Unknown secret placeholder|Secret cannot be safely)/.test(error.message)
        ? error.message : FAILURE;
      return { block: true, reason: message };
    }
  });

  pi.on("tool_result", (event, ctx) => protect(ctx, () => {
    const redactor = getSessionSecrets(ctx).redactor;
    // Discover across both fields before replacing either one.
    return redactor.redact({ content: event.content, details: event.details, isError: event.isError });
  }, {
    content: [{ type: "text" as const, text: FAILURE }], details: {}, isError: true,
  }));

  pi.on("context", (event, ctx) => protect(ctx, () => ({
    messages: getSessionSecrets(ctx).redactor.redact(event.messages),
  }), { messages: [] }));

  pi.on("before_provider_request", (event, ctx) => protect(ctx,
    () => getSessionSecrets(ctx).redactor.redact(event.payload), {}));

  // Summarization bypasses normal request hooks. Reuse Pi's summary algorithms
  // with sanitized copies of ALL their content inputs (including instructions).
  // Never fall back to an unredacted summary when an operation fails.
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const redactor = getSessionSecrets(ctx).redactor;
      const safe = redactor.redact({ preparation: event.preparation, instructions: event.customInstructions });
      Object.assign(event.preparation, safe.preparation);
      // Preserve Pi's normal auth, retries, and model selection when possible.
      // Pi doesn't read back event.customInstructions, so only instructions that
      // need masking require us to supply the summary ourselves.
      if (safe.instructions === event.customInstructions) return;
      if (!ctx.model) return { cancel: true };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return { cancel: true };
      if (auth.apiKey) redactor.registerSecret(auth.apiKey);
      const result = await compact(
        safe.preparation, ctx.model, auth.apiKey, auth.headers,
        safe.instructions, event.signal, pi.getThinkingLevel(),
      );
      return { compaction: redactor.redact(result) };
    } catch {
      reportFailure(ctx);
      return { cancel: true };
    }
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    try {
      const entries = event.preparation.entriesToSummarize;
      const safe = getSessionSecrets(ctx).redactor.redact({ entries, instructions: event.preparation.customInstructions });
      // Pi retains this array, not the event property. Replace its elements with
      // sanitized copies, without modifying the underlying session entries.
      for (let i = 0; i < entries.length; i++) entries[i] = safe.entries[i];
      return { customInstructions: safe.instructions };
    } catch {
      reportFailure(ctx);
      return { cancel: true };
    }
  });
}
