import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { redactForLlm } from "../secret-redaction/state";
import { isSystemPrompt, loadPrompts, type SystemPrompt } from "./prompts";

const ENTRY = "dynamic-system-prompts-selection";

export default function dynamicSystemPrompts(pi: ExtensionAPI): void {
  let active: SystemPrompt | undefined;

  function restore(ctx: ExtensionContext): void {
    active = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data = entry.data as { version?: unknown; prompt?: unknown } | undefined;
      if (data?.version === 1) active = isSystemPrompt(data.prompt) ? data.prompt : undefined;
    }
    if (ctx.hasUI) ctx.ui.setStatus("dynamic-system-prompts", active ? `System prompt: ${active.name}` : undefined);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", (event, ctx) => {
    restore(ctx);
    if (!active) return;
    // Compose with earlier extensions, never mutate the base prompt or accumulate copies.
    return { systemPrompt: redactForLlm(`${event.systemPrompt}\n\n${active.content}`, ctx) };
  });

  pi.registerCommand("system-prompts", {
    description: "Select a session system prompt; use <name>, list, status, or off",
    handler: async (args, ctx) => {
      restore(ctx);
      const name = args.trim();
      if (name === "status") {
        ctx.ui.notify(active ? `Active system prompt: ${active.name} (${active.source})` : "No dynamic system prompt active.", "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until the agent is idle before changing system prompts.", "warning");
        return;
      }
      const select = (prompt?: SystemPrompt) => {
        pi.appendEntry(ENTRY, { version: 1, prompt: prompt ?? null });
        restore(ctx);
        ctx.ui.notify(prompt ? `System prompt ${prompt.name} selected. Applies on the next request.` : "Dynamic system prompt disabled for future requests.", "info");
      };
      if (name === "off") { select(); return; }
      try {
        const prompts = loadPrompts(ctx.cwd);
        if (name === "list") {
          ctx.ui.notify(prompts.length ? prompts.map(prompt => `${prompt.name} (${prompt.source})${prompt.description ? ` — ${prompt.description}` : ""}`).join("\n") : "No system prompts found. Add Markdown files to .pi/system-prompts/ or your agent directory's system-prompts/.", "info");
          return;
        }
        if (name) {
          const prompt = prompts.find(item => item.name === name);
          if (!prompt) { ctx.ui.notify(`Unknown system prompt: ${name}. Use /system-prompts list.`, "error"); return; }
          select(prompt);
          return;
        }
        if (!ctx.hasUI) { ctx.ui.notify("Use /system-prompts <name> or off without an interactive UI.", "warning"); return; }
        if (!prompts.length) {
          ctx.ui.notify("No system prompts found. Add Markdown files to .pi/system-prompts/ or your agent directory's system-prompts/.", "info");
          return;
        }
        const labels = prompts.map(prompt => `${prompt.name} (${prompt.source})${prompt.description ? ` — ${prompt.description}` : ""}`);
        const disable = "Disable dynamic system prompt";
        const sessionId = ctx.sessionManager.getSessionId();
        const choice = await ctx.ui.select(`System prompts${active ? ` — active: ${active.name}` : ""}`, [...labels, disable]);
        if (!choice) return;
        if (ctx.sessionManager.getSessionId() !== sessionId || !ctx.isIdle()) {
          ctx.ui.notify("Session changed or became busy; system prompt selection cancelled.", "warning");
          return;
        }
        if (choice === disable) { select(); return; }
        const index = labels.indexOf(choice);
        if (index >= 0) select(prompts[index]);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Cannot load system prompts.", "error");
      }
    },
  });
}
