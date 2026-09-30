import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext,
  type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SystemOneBackend, shortlist, type DecisionBackend, type RoutingCandidate, type RoutingDecision } from "./decision";
import { decorateEditor, isOrdinarySubmission } from "./editor";
import { sessionContextSummary } from "./context-summary";
import { runtimeFor } from "./runtime";
import { canonicalWorkspace, registryPath, RegistryStore } from "./store";
import type { MemberSession, RuntimeState } from "./types";
import { compactUsage, extractUsage, normalizeUsage, savedContextTokens, sumUsage, usageLine } from "./usage";
import { redactForLlm } from "../secret-redaction/state";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type SwitchOptions = NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>;
type ReplacedSessionContext = Parameters<NonNullable<SwitchOptions["withSession"]>>[0];

const UI_KEY = "wpi-orchestrator";
const INTERNAL_PREFIX = "/orchestrator __dispatch ";
const COMMANDS = [
  { name: "help", usage: "help", description: "Show all orchestrator commands" },
  { name: "new", usage: "new <name>", description: "Create and enable a named virtual session" },
  { name: "on", usage: "on <name-or-id>", description: "Resume and enable a virtual session" },
  { name: "off", usage: "off", description: "Disable routing and hide status" },
  { name: "list", usage: "list", description: "List virtual sessions and usage" },
  { name: "status", usage: "status", description: "Show detailed status and usage" },
  { name: "rename", usage: "rename <name>", description: "Rename the selected virtual session" },
  { name: "delete", usage: "delete [name-or-id]", description: "Delete a virtual session after confirmation; keep real transcripts" },
  { name: "sessions", usage: "sessions", description: "Select a real member session" },
  { name: "attach", usage: "attach [name-or-id]", description: "Attach the current real session after confirmation" },
  { name: "compact", usage: "compact [instructions]", description: "Compact the current real session" },
  { name: "drafts", usage: "drafts", description: "Restore a held unsent draft" },
];
const HELP = ["Orchestrator commands:", ...COMMANDS.map(command =>
  `/orchestrator ${command.usage} — ${command.description}`)].join("\n");

export function parseCommand(args: string): { action: string; argument: string } {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  let argument = match?.[2]?.trim() ?? "";
  if ((argument.startsWith('"') && argument.endsWith('"')) ||
      (argument.startsWith("'") && argument.endsWith("'"))) argument = argument.slice(1, -1);
  return { action: match?.[1]?.toLowerCase() ?? "", argument };
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
}

function realName(virtualName: string, text: string): string {
  const title = text.split("\n").find(line => line.trim())?.trim().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 60) || "New task";
  return `${virtualName} / ${title}`;
}

/** Read only; never invoke SessionManager.open() to mutate/migrate other files. */
function transcript(member: MemberSession, workspace: string): unknown[] {
  const lines = readFileSync(member.file, "utf8").split("\n").filter(line => line.trim());
  const header = JSON.parse(lines[0] ?? "null");
  if (header?.type !== "session" || header.id !== member.id || canonicalWorkspace(header.cwd) !== workspace) {
    throw new Error("Member transcript identity/workspace does not match the registry.");
  }
  return lines.slice(1).map(line => JSON.parse(line));
}

export class Orchestrator {
  private store?: RegistryStore;
  private state?: RuntimeState;
  private savedFactory?: EditorFactory;
  private wrapperFactory?: EditorFactory;

  constructor(private readonly pi: ExtensionAPI, private readonly backend?: DecisionBackend) {}

  private initialize(ctx: ExtensionContext): { store: RegistryStore; state: RuntimeState } {
    const workspace = canonicalWorkspace(ctx.cwd);
    if (!this.store || this.store.workspace !== workspace) {
      this.store = new RegistryStore(registryPath(workspace), workspace);
      this.state = runtimeFor(workspace);
    }
    return { store: this.store, state: this.state! };
  }

  start(reason: string, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const { store, state } = this.initialize(ctx);
    const transition = state.transition;
    const internal = transition && transition.reason === reason &&
      (!transition.targetFile || transition.targetFile === ctx.sessionManager.getSessionFile());
    if (internal) {
      state.activeId = transition.virtualId;
      state.enabled = true;
    } else {
      state.enabled = false;
      state.activeId = store.read().lastSelectedVirtualId;
    }
    state.boundSessionId = ctx.sessionManager.getSessionId();
    if (state.enabled) this.installEditor(ctx);
    this.observe(ctx);
    if (!internal && state.activeId) ctx.ui.notify("Orchestrator paused. Use /orchestrator on <name> to resume.", "info");
  }

  shutdown(reason: string, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    this.observe(ctx);
    this.restoreEditor(ctx);
    const { state } = this.initialize(ctx);
    if (!state.transition || state.transition.reason !== reason) state.enabled = false;
  }

  observe(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const { store, state } = this.initialize(ctx);
    const id = ctx.sessionManager.getSessionId();
    if (store.read().members.some(member => member.id === id)) {
      store.reconcile(id, extractUsage(ctx.sessionManager.getEntries(), id), {
        name: ctx.sessionManager.getSessionName() || "Unnamed real session",
        summary: sessionContextSummary(ctx.sessionManager.getBranch()),
      });
    }
    this.showStatus(ctx, store, state);
  }

  private installEditor(ctx: ExtensionContext): void {
    const { state } = this.initialize(ctx);
    const commands = this.pi.getCommands?.().filter(command => command.name === "orchestrator" || command.name.startsWith("orchestrator:"));
    if (commands && commands.length > 1) {
      state.enabled = false;
      ctx.ui.notify("Multiple /orchestrator commands are registered; remove the duplicate before enabling editor routing.", "warning");
      return;
    }
    if (this.wrapperFactory) {
      if (ctx.ui.getEditorComponent() === this.wrapperFactory) return;
      state.enabled = false;
      ctx.ui.notify("Another extension replaced the editor; orchestrator routing is paused.", "warning");
      return;
    }
    this.savedFactory = ctx.ui.getEditorComponent();
    const previous = this.savedFactory;
    this.wrapperFactory = (tui, theme, keybindings) => {
      const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      return decorateEditor(base, text => {
        if (!state.enabled || !isOrdinarySubmission(text)) return text;
        if (ctx.ui.getEditorComponent() !== this.wrapperFactory) {
          state.enabled = false;
          ctx.ui.notify("Editor ownership changed; routing paused.", "warning");
          return text;
        }
        // Preserve Pi's current-session steering behavior while it is working.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) return text;
        const token = randomUUID();
        state.pending.set(token, { text, virtualId: state.activeId! });
        const heldIndex = state.heldDrafts.indexOf(text);
        if (heldIndex >= 0) state.heldDrafts.splice(heldIndex, 1);
        state.history.set(token, text);
        if (state.history.size > 64) state.history.delete(state.history.keys().next().value!);
        return INTERNAL_PREFIX + token;
      }, text => {
        const token = text.startsWith(INTERNAL_PREFIX) ? text.slice(INTERNAL_PREFIX.length) : "";
        return state.history.get(token) ?? text;
      });
    };
    ctx.ui.setEditorComponent(this.wrapperFactory);
  }

  private restoreEditor(ctx: ExtensionContext): void {
    if (this.wrapperFactory && ctx.ui.getEditorComponent() === this.wrapperFactory) {
      ctx.ui.setEditorComponent(this.savedFactory);
    }
    this.wrapperFactory = undefined;
    this.savedFactory = undefined;
  }

  private showStatus(ctx: ExtensionContext, store: RegistryStore, state: RuntimeState): void {
    const data = store.read();
    const virtual = data.virtualSessions.find(item => item.id === state.activeId);
    if (!state.enabled || !virtual) {
      ctx.ui.setStatus(UI_KEY, undefined);
      ctx.ui.setWidget(UI_KEY, undefined);
      return;
    }
    const realId = ctx.sessionManager.getSessionId();
    const groupUsage = sumUsage(data.usage.filter(item => item.virtualId === virtual.id).map(item => item.usage));
    const currentUsage = sumUsage(extractUsage(ctx.sessionManager.getEntries(), realId).map(item => item.usage));
    const name = virtual.name.replace(/[\r\n\t]/g, " ");
    const line = `${name} · V ${compactUsage(groupUsage)} · R ${compactUsage(currentUsage)}`;
    ctx.ui.setStatus(UI_KEY, undefined);
    ctx.ui.setWidget(UI_KEY, (_tui, theme) => ({
      render: width => [truncateToWidth(theme.fg("muted", line), width)],
      invalidate() {},
    }));
  }

  private restoreHeldDraft(ctx: ExtensionContext, state: RuntimeState): void {
    const draft = state.heldDrafts.at(-1);
    if (!draft) return;
    if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(draft);
    ctx.ui.notify(`${state.heldDrafts.length} unsent draft(s) retained in /orchestrator drafts.`, "info");
  }

  private async enable(id: string, ctx: ExtensionCommandContext): Promise<void> {
    const { state } = this.initialize(ctx);
    if (state.busy) throw new Error("An orchestrator operation is already in progress.");
    const epoch = ++state.epoch;
    state.busy = true;
    try { await this.activate(id, epoch, ctx); }
    finally { state.busy = false; }
  }

  private async activate(id: string, epoch: number, ctx: ExtensionCommandContext): Promise<void> {
    const { store, state } = this.initialize(ctx);
    await ctx.waitForIdle();
    if (state.epoch !== epoch) throw new Error("Orchestrator activation cancelled.");
    const data = store.read();
    const virtual = data.virtualSessions.find(item => item.id === id);
    if (!virtual) throw new Error("Unknown orchestrator.");
    const member = data.members.find(item => item.id === virtual.lastRealSessionId && item.virtualId === id);
    if (member && existsSync(member.file)) transcript(member, store.workspace);
    store.update(registry => { registry.lastSelectedVirtualId = id; });
    state.activeId = id;
    state.enabled = true;
    if (member && existsSync(member.file) && member.id !== ctx.sessionManager.getSessionId()) {
      state.transition = { reason: "resume", virtualId: id, targetFile: member.file };
      try {
        const result = await ctx.switchSession(member.file, {
          withSession: async fresh => { this.showStatus(fresh, store, state); },
        });
        if (result.cancelled) {
          state.enabled = false;
          this.showStatus(ctx, store, state);
          ctx.ui.notify("Session switch cancelled; routing remains paused.", "warning");
        }
      } finally { state.transition = undefined; }
      return;
    }
    this.installEditor(ctx);
    this.showStatus(ctx, store, state);
  }

  private async pickDecision(text: string, candidates: RoutingCandidate[], ctx: ExtensionCommandContext,
    virtualId: string, requestId: string, store: RegistryStore): Promise<RoutingDecision | undefined> {
    if (!candidates.length) return { action: "new", reason: "No eligible member session exists." };
    if (this.backend) {
      try {
        // Direct classifier calls do not pass through Pi's provider hooks.
        const safeInput = redactForLlm({ text, contexts: candidates.map(item => ({ summary: item.summary || item.goal })) }, ctx);
        const safeCandidates = candidates.map((item, index) => ({ ...item, ...safeInput.contexts[index] }));
        const result = await this.backend.evaluate(safeInput.text, safeCandidates);
        store.record({ source: `decision:${requestId}`, virtualId, category: "decision", usage: result.usage ?? normalizeUsage(undefined) });
        if (result.decision.action !== "clarify") return result.decision;
        ctx.ui.notify("Decision scores are ambiguous; continuing the current session.", "info");
      } catch {
        store.record({ source: `decision:${requestId}`, virtualId, category: "decision", usage: normalizeUsage(undefined) });
        ctx.ui.notify("Decision backend unavailable or invalid; continuing the current session.", "warning");
      }
      const current = candidates.find(item => item.id === ctx.sessionManager.getSessionId());
      if (!current) throw new Error("No eligible current session for decision fallback. No worker request was sent.");
      return { action: "reuse", realId: current.id, reason: "Decision was inconclusive or unavailable; retained the current session." };
    }
    const labels = candidates.map(item => `Continue: ${item.name} [${item.id.slice(0, 8)}]`);
    const selection = await ctx.ui.select("Route this request (same topic is not necessarily the same task)", ["Create a new focused session", ...labels]);
    if (!selection) return undefined;
    const index = labels.indexOf(selection);
    if (index >= 0) return { action: "reuse", realId: candidates[index].id, reason: "User selected task continuity." };
    if (selection === "Create a new focused session") return { action: "new", reason: "User selected independent work." };
    throw new Error("Invalid task selection.");
  }

  private async dispatch(token: string, ctx: ExtensionCommandContext): Promise<void> {
    const { store, state } = this.initialize(ctx);
    const envelope = state.pending.get(token);
    if (!envelope || !state.enabled || envelope.virtualId !== state.activeId) {
      throw new Error("Invalid or expired orchestrator submission. No worker request was sent.");
    }
    if (state.busy) {
      state.heldDrafts.push(envelope.text);
      ctx.ui.setEditorText(envelope.text);
      state.pending.delete(token);
      ctx.ui.notify("Routing is already in progress; this draft was not sent. Submit again after it finishes.", "warning");
      return;
    }
    const sourceId = ctx.sessionManager.getSessionId();
    const virtualId = envelope.virtualId;
    const text = envelope.text;
    let release: (() => void) | undefined;
    let replaced = false;
    let admitted = false;
    try {
      release = store.lease();
      state.busy = true;
      await ctx.waitForIdle();
      if (state.activeId !== virtualId || !state.enabled) throw new Error("Orchestrator activation changed before routing.");
      if (!ctx.sessionManager.getSessionFile()) throw new Error("Orchestration requires persistent Pi sessions; remove --no-session.");
      this.observe(ctx);
      const data = store.read();
      const previous = data.requests.find(item => item.id === token);
      if (previous) throw new Error("This request was already admitted; do not replay potentially side-effecting work.");
      store.update(registry => { registry.requests.push({ id: token, virtualId, state: "pending" }); });
      admitted = true;
      const virtual = data.virtualSessions.find(item => item.id === virtualId)!;
      const members = data.members.filter(item => item.virtualId === virtualId && existsSync(item.file));
      const savedTokens = new Map<string, number | null>();
      for (const member of members) {
        const entries = transcript(member, store.workspace);
        store.reconcile(member.id, extractUsage(entries, member.id));
        savedTokens.set(member.id, savedContextTokens(entries));
      }
      const reconciled = store.read();
      const currentContext = ctx.getContextUsage();
      const candidates: RoutingCandidate[] = shortlist(text,
        reconciled.members.filter(item => members.some(member => member.id === item.id)), virtual.lastRealSessionId)
        .map(member => ({
          ...member,
          metrics: {
            lifetimeUsage: sumUsage(reconciled.usage.filter(item => item.realId === member.id).map(item => item.usage)),
            context: member.id === sourceId
              ? { tokens: currentContext?.tokens ?? null, contextWindow: currentContext?.contextWindow ?? null, estimated: false }
              : { tokens: savedTokens.get(member.id) ?? null, contextWindow: null, estimated: true },
          },
        }));
      const decision = await this.pickDecision(text, candidates, ctx, virtualId, token, store);
      if (!decision) {
        store.update(registry => { registry.requests.find(item => item.id === token)!.state = "interrupted"; });
        ctx.ui.setEditorText(text);
        ctx.ui.notify("Routing cancelled; draft restored.", "info");
        return;
      }
      if (!state.enabled || state.activeId !== virtualId) throw new Error("Orchestration was disabled before dispatch; no worker request was sent.");
      // Every route gets an awaited, fresh-context delivery in this first slice.
      // This also replaces the runtime on same-member reuse (documented limitation).
      const deliver = async (fresh: ReplacedSessionContext) => {
        replaced = true;
        const realId = fresh.sessionManager.getSessionId();
        try {
          store.update(registry => {
            const request = registry.requests.find(item => item.id === token)!;
            request.realId = realId;
            request.reason = decision.reason;
            request.state = "dispatching";
            registry.virtualSessions.find(item => item.id === virtualId)!.lastRealSessionId = realId;
          });
          this.showStatus(fresh, store, state);
          if (realId !== sourceId) {
            fresh.ui.notify(`Session changed to ${fresh.sessionManager.getSessionName() || "Unnamed real session"}. ${decision.reason}`, "info");
          }
          await fresh.sendUserMessage(text);
          store.reconcile(realId, extractUsage(fresh.sessionManager.getEntries(), realId), {
            name: fresh.sessionManager.getSessionName() || "Unnamed real session",
            summary: sessionContextSummary(fresh.sessionManager.getBranch()),
          });
          const lastAssistant = [...fresh.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
          const failed = lastAssistant?.type === "message" && lastAssistant.message.role === "assistant"
            && ["aborted", "error"].includes(lastAssistant.message.stopReason);
          store.update(registry => { registry.requests.find(item => item.id === token)!.state = failed ? "interrupted" : "completed"; });
          this.showStatus(fresh, store, state);
        } catch {
          store.update(registry => { registry.requests.find(item => item.id === token)!.state = "interrupted"; });
          fresh.ui.notify("Orchestrated request interrupted. Inspect the real transcript before retrying; tools may have changed files.", "error");
        } finally {
          this.restoreHeldDraft(fresh, state);
        }
      };
      if (decision.action === "new") {
        const name = realName(virtual.name, text);
        state.transition = { reason: "new", virtualId };
        const result = await ctx.newSession({
          setup: async manager => {
            const file = manager.getSessionFile();
            if (!file) throw new Error("New Pi session is not persistent.");
            manager.appendSessionInfo(name);
            store.attach({ id: manager.getSessionId(), virtualId, file, name, goal: text.slice(0, 1000),
              summary: `Latest turn:\nuser: ${text.slice(0, 300)}`, lastActivityAt: new Date().toISOString(), origin: "created", baselineSources: [] }, []);
          },
          withSession: deliver,
        });
        if (result.cancelled) throw new Error("New session creation cancelled.");
      } else {
        const member = candidates.find(item => item.id === decision.realId);
        if (!member) throw new Error("Decision selected a session outside the candidate allowlist.");
        transcript(member, store.workspace);
        state.transition = { reason: "resume", virtualId, targetFile: member.file };
        const result = await ctx.switchSession(member.file, { withSession: deliver });
        if (result.cancelled) throw new Error("Session switch cancelled.");
      }
    } catch (error) {
      if (admitted) {
        try {
          store.update(registry => {
            const request = registry.requests.find(item => item.id === token);
            if (request) request.state = "interrupted";
          });
        } catch { /* preserve the original failure if the registry itself is unavailable */ }
      }
      // Never use old session-bound UI after replacement or failed teardown.
      if (!replaced && state.boundSessionId === sourceId) {
        ctx.ui.setEditorText(text);
        ctx.ui.notify(error instanceof Error ? error.message : "Routing failed; draft restored.", "error");
      } else if (!replaced) {
        console.error("Orchestrator session replacement failed; inspect /orchestrator status and the real transcript before retrying.");
      }
    } finally {
      state.transition = undefined;
      state.busy = false;
      state.pending.delete(token);
      release?.();
    }
  }

  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") throw new Error("/orchestrator currently requires the Pi terminal editor.");
    const { store, state } = this.initialize(ctx);
    const { action, argument } = parseCommand(args);
    if (action === "__dispatch") { await this.dispatch(argument, ctx); return; }
    if (action === "help") { ctx.ui.notify(HELP, "info"); return; }
    if (state.busy && !["status", "list", "off"].includes(action)) {
      throw new Error("An orchestrator request is running. Wait for it to finish before changing sessions.");
    }
    if (action === "off") {
      state.epoch++;
      state.enabled = false;
      this.restoreEditor(ctx);
      this.showStatus(ctx, store, state);
      return;
    }
    if (action === "new") { await this.enable(store.create(argument).id, ctx); return; }
    if (action === "on") { await this.enable(store.find(argument).id, ctx); return; }
    if (action === "rename") {
      if (!state.activeId) throw new Error("Select an orchestrator first.");
      store.rename(state.activeId, argument);
      this.showStatus(ctx, store, state);
      return;
    }
    if (action === "delete") {
      if (!argument && !state.activeId) throw new Error("Select an orchestrator or use /orchestrator delete <name-or-id>.");
      const virtual = store.find(argument || state.activeId!);
      state.busy = true;
      try {
        if (!(await ctx.ui.confirm(`Delete orchestrator ${virtual.name}?`,
          "Its membership, usage, and request metadata will be removed. Real Pi session transcripts are kept. This cannot be undone."))) return;
        store.delete(virtual.id);
        for (const [token, pending] of state.pending) {
          if (pending.virtualId !== virtual.id) continue;
          if (!state.heldDrafts.includes(pending.text)) state.heldDrafts.push(pending.text);
          state.pending.delete(token);
        }
        if (state.activeId === virtual.id) {
          state.epoch++;
          state.enabled = false;
          state.activeId = undefined;
          this.restoreEditor(ctx);
        }
        this.showStatus(ctx, store, state);
        ctx.ui.notify(`Deleted orchestrator ${virtual.name}. Real session transcripts were kept.`, "info");
      } finally { state.busy = false; }
      return;
    }
    if (action === "attach") {
      if (!state.activeId && !argument) throw new Error("Select an orchestrator or use /orchestrator attach <name-or-id>.");
      await ctx.waitForIdle();
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("Cannot attach an ephemeral session.");
      const virtual = store.find(argument || state.activeId!);
      const id = ctx.sessionManager.getSessionId();
      const goal = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
      const name = ctx.sessionManager.getSessionName() || realName(virtual.name, goal?.type === "message" ? textOf(goal.message) : "Attached task");
      if (store.read().members.some(member => member.id === id)) throw new Error("Real session already belongs to an orchestrator.");
      if (!(await ctx.ui.confirm(`Attach current real session to ${virtual.name}?`, "Its context becomes a routing candidate. Earlier costs are excluded from the virtual total."))) return;
      if (!ctx.sessionManager.getSessionName()) this.pi.setSessionName(name);
      store.attach({ id, virtualId: virtual.id, file, name, goal: goal?.type === "message" ? textOf(goal.message).slice(0, 1000) : name,
        summary: sessionContextSummary(ctx.sessionManager.getBranch()), lastActivityAt: new Date().toISOString(), origin: "attached", baselineSources: [] }, extractUsage(ctx.sessionManager.getEntries(), id));
      await this.enable(virtual.id, ctx);
      return;
    }
    if (action === "drafts") {
      const labels = state.heldDrafts.map((text, index) => `${index + 1}. ${text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80)}`);
      if (!labels.length) { ctx.ui.notify("No held drafts.", "info"); return; }
      const choice = await ctx.ui.select("Restore an unsent draft (process-local, not an execution queue)", labels);
      const index = choice ? labels.indexOf(choice) : -1;
      if (index >= 0) ctx.ui.setEditorText(state.heldDrafts[index]);
      return;
    }
    if (action === "compact") {
      await ctx.waitForIdle();
      await new Promise<void>((resolve, reject) => ctx.compact({ customInstructions: argument || "Preserve task decisions, constraints, exact identifiers, and unfinished work.", onComplete: () => resolve(), onError: reject }));
      this.observe(ctx);
      return;
    }
    this.observe(ctx);
    if (action === "status") {
      const data = store.read();
      const virtual = data.virtualSessions.find(item => item.id === state.activeId);
      const events = data.usage.filter(item => item.virtualId === virtual?.id);
      const members = data.members.filter(item => item.virtualId === virtual?.id);
      const lines = [virtual ? `Orchestrator: ${virtual.name} [${virtual.id}]` : "No orchestrator selected.",
        `Routing: ${state.enabled ? "on" : "paused"}`,
        `Virtual created: ${data.virtualSessions.length} | real created: ${members.filter(item => item.origin === "created").length} | attached: ${members.filter(item => item.origin === "attached").length} | members: ${members.length}`,
        `Registry: ${store.file}`, usageLine("Virtual total", sumUsage(events.map(item => item.usage)))];
      for (const category of ["worker", "tool", "decision", "summary", "warming"] as const) {
        lines.push(usageLine(category, sumUsage(events.filter(item => item.category === category).map(item => item.usage))));
      }
      const realId = ctx.sessionManager.getSessionId();
      lines.push(usageLine("Current real lifetime (not added again)", sumUsage(extractUsage(ctx.sessionManager.getEntries(), realId).map(item => item.usage))));
      lines.push(usageLine("Current real contribution", sumUsage(events.filter(item => item.realId === realId).map(item => item.usage))));
      lines.push(`Decision backend: ${this.backend ? "configured" : "manual clarification (no paid classifier calls)"}`);
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }
    if (action === "list") {
      const data = store.read();
      ctx.ui.notify(data.virtualSessions.map(virtual => `${virtual.name} [${virtual.id}] | ${data.members.filter(item => item.virtualId === virtual.id).length} real sessions | `
        + usageLine("total", sumUsage(data.usage.filter(item => item.virtualId === virtual.id).map(item => item.usage)))).join("\n") || "No virtual sessions. Use /orchestrator new <name>.", "info");
      return;
    }
    if (action === "sessions") {
      const data = store.read();
      const members = data.members.filter(item => item.virtualId === state.activeId);
      const labels = members.map(item => `${item.name} [${item.id.slice(0, 8)}]`);
      const selected = await ctx.ui.select("Real member sessions", labels);
      const index = selected ? labels.indexOf(selected) : -1;
      if (index >= 0) {
        store.update(registry => { registry.virtualSessions.find(item => item.id === state.activeId)!.lastRealSessionId = members[index].id; });
        await this.enable(state.activeId!, ctx);
      }
      return;
    }
    if (!action) {
      const data = store.read();
      const labels = data.virtualSessions.map(item => `${item.name} [${item.id.slice(0, 8)}]`);
      const choice = await ctx.ui.select("Orchestrator", ["Help — available commands", "Create a named virtual session", ...labels]);
      if (choice === "Help — available commands") {
        ctx.ui.notify(HELP, "info");
      } else if (choice === "Create a named virtual session") {
        const name = await ctx.ui.input("Virtual session name");
        if (name !== undefined) await this.enable(store.create(name).id, ctx);
      } else if (choice) {
        const index = labels.indexOf(choice);
        if (index >= 0) await this.enable(data.virtualSessions[index].id, ctx);
      }
      return;
    }
    throw new Error(`Unknown orchestrator command: ${action}. Use /orchestrator help for available commands.`);
  }
}

export default function (pi: ExtensionAPI) {
  // No network calls during extension load. Hosted classification is opt-in.
  const url = process.env.WPI_ORCHESTRATOR_DECISION_URL;
  let backend: DecisionBackend | undefined;
  let invalidBackend = false;
  if (url) {
    try { backend = new SystemOneBackend(url, process.env.WPI_ORCHESTRATOR_DECISION_MODEL || "multilingual",
      process.env.WPI_ORCHESTRATOR_DECISION_API_KEY); }
    catch { invalidBackend = true; }
  }
  const orchestrator = new Orchestrator(pi, backend);
  const safe = (ctx: ExtensionContext, operation: () => void) => {
    try { operation(); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Orchestrator state error.", "error"); }
  };
  pi.registerCommand("orchestrator", {
    description: "Named virtual sessions and routing; /orchestrator help lists commands",
    getArgumentCompletions: prefix => {
      const matches = COMMANDS.filter(command => command.name.startsWith(prefix.toLowerCase()));
      return matches.length ? matches.map(command => ({
        value: command.name, label: command.usage, description: command.description,
      })) : null;
    },
    handler: async (args, ctx) => {
      try { await orchestrator.command(args, ctx); }
      catch (error) {
        // Management errors occur before replacement; dispatch owns its fresh-context errors.
        try { ctx.ui.notify(error instanceof Error ? error.message : "Orchestrator command failed.", "error"); } catch { /* old runtime was invalidated */ }
      }
    },
  });
  pi.on("session_start", (event, ctx) => safe(ctx, () => {
    orchestrator.start(event.reason, ctx);
    if (invalidBackend && ctx.mode === "tui") ctx.ui.notify("Invalid orchestrator decision URL; manual clarification is available.", "warning");
  }));
  pi.on("session_shutdown", (event, ctx) => safe(ctx, () => orchestrator.shutdown(event.reason, ctx)));
  // Reconciliation, not a claim that low-level agent_end is the final settled boundary.
  // Awaited fresh-context dispatch performs the authoritative completion update.
  pi.on("turn_end", (_event, ctx) => safe(ctx, () => orchestrator.observe(ctx)));
  pi.on("agent_end", (_event, ctx) => safe(ctx, () => orchestrator.observe(ctx)));
  pi.on("session_compact", (_event, ctx) => safe(ctx, () => orchestrator.observe(ctx)));
  pi.on("session_tree", (_event, ctx) => safe(ctx, () => orchestrator.observe(ctx)));
}
