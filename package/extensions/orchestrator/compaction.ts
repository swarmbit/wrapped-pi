import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PRESERVE = "Preserve task decisions, constraints, exact identifiers, file changes, unresolved questions, and unfinished work. Keep enough detail to continue safely.";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Older Pi's isIdle only means !isStreaming, not final settlement. Do not use
// agent_end or polling as a substitute: recovery/automatic compaction may follow.
export function supportsDeferredCompaction(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 0 || (major === 0 && (minor > 99 || (minor === 99 && patch >= 1)));
}

export interface DeferredActionGate { owner?: "compact" | "switch" }

export function installCompaction(pi: ExtensionAPI, enabled: (ctx: ExtensionContext) => boolean,
  options = {
    interval: positiveInteger(process.env.WPI_ORCHESTRATOR_COMPACT_TURNS, 10),
    minTokens: positiveInteger(process.env.WPI_ORCHESTRATOR_COMPACT_MIN_TOKENS, 30_000),
    supported: supportsDeferredCompaction(VERSION ?? ""),
  }, gate: DeferredActionGate = {}): void {
  let pending: { session: string; instructions: string } | undefined;
  let running = false;
  let generation = 0;
  let reminder: { session: string; turns: number } | undefined;
  const turnsSinceCompaction = (ctx: ExtensionContext) => {
    let turns = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "compaction") turns = 0;
      else if (entry.type === "message" && entry.message.role === "assistant" &&
        entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted") turns++;
    }
    return turns;
  };
  const eligible = (ctx: ExtensionContext) => options.supported && enabled(ctx) && !running &&
    (!gate.owner || gate.owner === "compact") &&
    turnsSinceCompaction(ctx) >= options.interval &&
    (ctx.getContextUsage()?.tokens ?? 0) >= options.minTokens;
  const release = () => { if (gate.owner === "compact") gate.owner = undefined; };
  const reset = () => { generation++; pending = undefined; reminder = undefined; if (!running) release(); };
  const notify = (ctx: ExtensionContext, text: string, level: "info" | "error") => {
    try { if (ctx.hasUI) ctx.ui.notify(text, level); }
    catch { /* The runtime may have been replaced during summarization. */ }
  };

  pi.registerTool({
    name: "request_compaction",
    label: "Request compaction",
    description: "Schedule context compaction after this agent run safely finishes. Use at a completed milestone when older context can be summarized without losing unfinished work. Consider summarization cost and cache invalidation; savings are not guaranteed. Does not compact inside the tool or immediately stop the run.",
    parameters: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2000, description: "Why this is a safe and worthwhile compaction boundary" }),
      preservation_notes: Type.String({ minLength: 1, maxLength: 6000, description: "Decisions, identifiers, constraints, and pending work the summary must preserve" }),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (!eligible(ctx)) throw new Error("Compaction unavailable: requires Pi 0.99.1+, enabled orchestrator membership, enough completed turns and known context tokens, and no compaction in progress.");
      if (ctx.signal?.aborted) throw new Error("Compaction request cancelled.");
      const session = ctx.sessionManager.getSessionId();
      if (pending) throw new Error("A compaction request is already pending.");
      gate.owner = "compact";
      pending = { session, instructions: `${PRESERVE}\nReason: ${args.reason}\nPreservation notes: ${args.preservation_notes}` };
      return {
        content: [{ type: "text", text: "Compaction scheduled after this run finishes and the session is idle. This is not confirmation of completion. Finish your response normally; do not request it again. New user input or session changes cancel the request." }],
        details: { status: "scheduled", session },
      };
    },
  });

  // Request-local reminder: no separate decision-model call or extra agent turn.
  pi.on("context", (event, ctx) => {
    if (!eligible(ctx) || pending) return;
    const session = ctx.sessionManager.getSessionId();
    const turns = turnsSinceCompaction(ctx);
    if (reminder?.session === session && turns >= reminder.turns && turns - reminder.turns < options.interval) return;
    reminder = { session, turns };
    const usage = ctx.getContextUsage();
    return { messages: [...event.messages, {
      role: "user" as const,
      content: `[Orchestrator compaction review] ${turns} completed turns since compaction; context approximately ${usage?.tokens} / ${usage?.contextWindow} tokens. Decide whether this is a safe milestone for compaction. Consider future work, summary cost, cache invalidation, and information loss. If worthwhile, call request_compaction with preservation notes; otherwise continue normally. This is a review, not an instruction to compact.`,
      timestamp: Date.now(),
    }] };
  });
  const cancelRequest = () => { generation++; pending = undefined; if (!running) release(); };
  pi.on("before_agent_start", cancelRequest);
  pi.on("input", cancelRequest);
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);

  // Register by name through a compatibility type: the development API (0.79.1)
  // predates this notification. Unsupported versions never accept requests.
  const onSettled = pi.on.bind(pi) as unknown as (name: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => void) => void;
  if (options.supported) onSettled("agent_settled", (_event, ctx) => {
    const request = pending;
    if (!request) return;
    pending = undefined;
    if (request.session !== ctx.sessionManager.getSessionId() || ctx.signal?.aborted ||
      !eligible(ctx) || ctx.hasPendingMessages()) { release(); return; }
    // agent_settled itself is notification-only and still contributes to Pi's
    // busy state. Yield once, then recheck idle without polling or awaiting here.
    const scheduledGeneration = generation;
    setTimeout(() => {
      try {
        if (generation !== scheduledGeneration) return;
        if (request.session !== ctx.sessionManager.getSessionId() || !eligible(ctx) ||
          !ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted) { release(); return; }
        running = true;
        ctx.compact({
          customInstructions: request.instructions,
          onComplete: () => {
            running = false;
            release();
            notify(ctx, "Orchestrator compaction completed.", "info");
          },
          onError: error => {
            running = false;
            release();
            notify(ctx, `Orchestrator compaction failed: ${error.message}`, "error");
          },
        });
      } catch { running = false; release(); /* Session/runtime invalidated before idle execution. */ }
    }, 0);
  });
}
