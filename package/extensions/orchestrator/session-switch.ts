import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Orchestrator } from "./index";
import { redactForLlm } from "../secret-redaction/state";
import { supportsDeferredCompaction, type DeferredActionGate } from "./compaction";

export function installSessionSwitch(pi: ExtensionAPI, orchestrator: Orchestrator,
  gate: DeferredActionGate, supported = supportsDeferredCompaction(VERSION ?? "")): { finishDispatch(handle: string): void } {
  let pending: { token: string; session: string; ctx: ExtensionContext; dispatched?: boolean } | undefined;
  let generation = 0;
  const cancel = () => {
    generation++;
    if (pending) {
      try { orchestrator.cancelSwitch(pending.token, pending.ctx); } catch { /* expired runtime */ }
      pending = undefined;
    }
    if (gate.owner === "switch") gate.owner = undefined;
  };
  const schedule = (ctx: ExtensionContext, reason: string, notes: string, target?: string) => {
    if (!supported || ctx.signal?.aborted) throw new Error("Session-change tools require Pi 0.99.1+ and an active non-aborted session.");
    if (gate.owner) throw new Error("A deferred switch or compaction is already pending.");
    const token = target === undefined
      ? orchestrator.scheduleNewSession(reason, notes, ctx)
      : orchestrator.scheduleSwitch(target, reason, notes, ctx);
    pending = { token, session: ctx.sessionManager.getSessionId(), ctx };
    gate.owner = "switch";
    return { content: [{ type: "text" as const, text: "Session change scheduled after this run settles. The decision model will evaluate handoff needs before delivery. This is not confirmation of switching. Finish normally; do not request another session change." }],
      details: { status: "scheduled", action: target === undefined ? "new" : "reuse", target } };
  };
  pi.registerTool({
    name: "list_sessions",
    label: "List orchestrator sessions",
    description: "List existing members of the active virtual session, including the current member, with IDs, names, recent user/assistant context and prompt-token estimates. Use this to inspect task fit before request_session_switch or request_new_session. Results are paginated and summaries are bounded; use session_id to inspect one member in more detail. Tool calls in summaries are attempts, not verified success. Other virtual sessions and workspaces are excluded.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const members = orchestrator.listSessions(ctx);
      const filtered = args.session_id ? members.filter(member => member.id === args.session_id) : members;
      if (args.session_id && !filtered.length) throw new Error("Session is not an available member of the active virtual session.");
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 10;
      const summaryLimit = args.session_id ? 12000 : 2000;
      const result = redactForLlm({ total: filtered.length,
        next_offset: offset + limit < filtered.length ? offset + limit : null,
        sessions: filtered.slice(offset, offset + limit).map(member => ({ ...member,
          summary: member.summary.slice(0, summaryLimit), summary_truncated: member.summary.length > summaryLimit })),
      }, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "request_session_switch",
    label: "Request session switch",
    description: "Schedule a switch to an existing member of the active virtual session after this run finishes. Use list_sessions to inspect recent context and IDs. Use when the destination's prior work, decisions, or task focus make it a clearly better fit for the user's current request. A shorter destination with sufficient context can be preferable; do not switch for tiny savings or keyword similarity alone. Preserve needed source context; the decision model evaluates handoff needs. Only one model-requested session change (switch or new) per user submission. Finish normally after scheduling.",
    parameters: Type.Object({
      target_session_id: Type.String({ minLength: 1, maxLength: 200 }),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
      preservation_notes: Type.String({ maxLength: 6000 }),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      return schedule(ctx, args.reason, args.preservation_notes, args.target_session_id);
    },
  });
  pi.registerTool({
    name: "request_new_session",
    label: "Request new session",
    description: "Schedule a fresh real session within the active virtual session for the user's current request after this run finishes. Use when the incoming task is distinct or self-contained and extending the current context is a poor fit; inspect list_sessions first for an existing suitable member. Dependent follow-ups normally stay here. The new session receives the original user request, not a newly invented task, plus any handoff selected by the decision model. Worker model selection uses the configured allowlist or the current model. Only one model-requested session change (switch or new) per user submission. Avoid starting the unrelated work here; finish normally after scheduling. This does not create a new virtual session.",
    parameters: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
      preservation_notes: Type.String({ maxLength: 6000 }),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      return schedule(ctx, args.reason, args.preservation_notes);
    },
  });
  pi.on("before_agent_start", cancel);
  pi.on("input", cancel);
  pi.on("session_start", cancel);
  pi.on("session_shutdown", cancel);
  pi.on("session_tree", cancel);
  pi.on("session_compact", cancel);
  const onSettled = pi.on.bind(pi) as unknown as (name: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => void) => void;
  if (supported) onSettled("agent_settled", (_event, ctx) => {
    const request = pending;
    if (!request || request.dispatched) return;
    const epoch = generation;
    setTimeout(() => {
      if (epoch !== generation || request.dispatched) return;
      try {
        if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted ||
          ctx.sessionManager.getSessionId() !== request.session || !orchestrator.compactionEnabled(ctx) ||
          !orchestrator.switchPending(request.token, ctx)) {
          cancel(); return;
        }
        // Pi 0.99.1+ explicitly supports command dispatch through this option.
        // Keep the token pending until dispatch consumes it or lifecycle cancels.
        const send = pi.sendUserMessage.bind(pi) as (text: string, options: { expandPromptTemplates: boolean }) => void;
        request.dispatched = true;
        send(`/orchestrator __dispatch ${request.token}`, { expandPromptTemplates: true });
      } catch { cancel(); }
    }, 0);
  });
  return { finishDispatch: handle => { if (pending?.token === handle) cancel(); } };
}
