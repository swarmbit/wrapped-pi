import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionBackend, DecisionResult } from "./decision";
import { registryPath, RegistryStore } from "./store";
import { runtimeFor } from "./runtime";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "0.79.1",
  InteractiveMode: class {
    ui: any;
    sessionManager: any;
    displayed: any;
    renderSessionContext(context: any) { this.displayed = context; }
    rebuildChatFromMessages() {
      this.renderSessionContext({ messages: this.sessionManager.getBranch().filter((entry: any) => entry.type === "message").map((entry: any) => entry.message) });
    }
  },
  CustomEditor: class {
    text = "";
    history: string[] = [];
    actionHandlers = new Map();
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;
    getText() { return this.text; }
    getExpandedText() { return this.text; }
    setText(text: string) { this.text = text; }
    addToHistory(text: string) { this.history.push(text); }
    handleInput() {}
    render() { return [this.text]; }
    invalidate() {}
  },
}));
vi.mock("@earendil-works/pi-tui", () => ({ truncateToWidth: (text: string, width: number) => text.slice(0, width) }));

import extension, { Orchestrator, parseCommand } from "./index";
import { CustomEditor, InteractiveMode } from "@earendil-works/pi-coding-agent";

let dir: string;
let workspace: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orchestrator-integration-"));
  workspace = dir;
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function harness(backend?: DecisionBackend, customFactory?: (...args: any[]) => any) {
  const sent: Array<{ realId: string; text: string }> = [];
  let serial = 0;
  let current: any;
  let failWorker = false;
  let cancelReplacement = false;
  let beforeSend: (() => Promise<void>) | undefined;
  const tui = {};
  const chat = new InteractiveMode({} as any) as any;
  chat.ui = tui;

  const create = (id: string = randomUUID()) => {
    let alive = true;
    let idle = true;
    const entries: any[] = [];
    const file = join(workspace, `${id}.jsonl`);
    const assertAlive = () => { if (!alive) throw new Error("STALE CONTEXT"); };
    const persist = () => {
      entries.forEach((entry, index) => {
        if (entry.parentId === undefined) entry.parentId = entries[index - 1]?.id ?? null;
        if (entry.timestamp?.startsWith("time-")) entry.timestamp = new Date(Number(entry.timestamp.slice(5)) * 1000).toISOString();
      });
      writeFileSync(file, [{ type: "session", version: 3, id, cwd: workspace }, ...entries].map(item => JSON.stringify(item)).join("\n") + "\n");
    };
    const manager = {
      getSessionId: () => { assertAlive(); return id; },
      getSessionFile: () => { assertAlive(); return file; },
      getSessionName: () => entries.filter(item => item.type === "session_info").at(-1)?.name,
      getEntries: () => entries,
      getBranch: () => entries,
      appendSessionInfo: (name: string) => { entries.push({ type: "session_info", id: `entry-${++serial}`, timestamp: `time-${serial}`, name }); persist(); },
    };
    persist();
    let factory = customFactory;
    let editor: any;
    const submitted: string[] = [];
    const ui = {
      notify: vi.fn((..._args: any[]) => assertAlive()),
      select: vi.fn().mockResolvedValue("Create a new focused session"),
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn(),
      getEditorComponent: () => { assertAlive(); return factory; },
      setEditorComponent: (next: any) => {
        assertAlive();
        const draft = editor?.getText() ?? "";
        factory = next;
        editor = next ? next(tui, {}, {}) : new CustomEditor({} as any, {} as any, {} as any);
        editor.onSubmit = (text: string) => submitted.push(text);
        editor.setText(draft);
      },
      setEditorText: (text: string) => { assertAlive(); editor.setText(text); },
      getEditorText: () => { assertAlive(); return editor.getText(); },
      setStatus: vi.fn((..._args: any[]) => assertAlive()),
      setWidget: vi.fn((..._args: any[]) => assertAlive()),
      theme: { fg: (_color: string, text: string) => text },
    };
    const pi: any = { setSessionName: vi.fn((name: string) => { assertAlive(); manager.appendSessionInfo(name); }) };
    const orchestrator = new Orchestrator(pi, backend);
    const replace = async (reason: string, opts: any, targetId?: string, targetEntries?: any[]) => {
      assertAlive();
      if (cancelReplacement) return { cancelled: true };
      orchestrator.shutdown(reason, ctx as any);
      alive = false;
      const next = create(targetId);
      if (targetEntries) { next.entries.push(...targetEntries); next.persist(); }
      current = next;
      next.orchestrator.start(reason, next.ctx);
      await opts?.setup?.(next.ctx.sessionManager);
      await opts?.withSession?.(next.ctx);
      chat.rebuildChatFromMessages();
      return { cancelled: false };
    };
    const ctx: any = {
      cwd: workspace, mode: "tui", hasUI: true, ui, sessionManager: manager,
      isIdle: () => { assertAlive(); return idle; },
      hasPendingMessages: () => false,
      getContextUsage: () => { assertAlive(); return { tokens: 24, contextWindow: 200000 }; },
      waitForIdle: async () => { assertAlive(); },
      newSession: vi.fn((opts: any) => replace("new", opts)),
      switchSession: vi.fn((target: string, opts: any) => {
        const lines = readFileSync(target, "utf8").trim().split("\n").map(line => JSON.parse(line));
        return replace("resume", opts, lines[0].id, lines.slice(1));
      }),
      compact: vi.fn((opts: any) => {
        entries.push({ type: "compaction", id: `summary-${++serial}`, timestamp: `time-${serial}`, summary: "compact", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } });
        persist();
        opts.onComplete({});
      }),
      sendUserMessage: vi.fn(async (text: string) => {
        assertAlive();
        idle = false;
        sent.push({ realId: id, text });
        entries.push({ type: "message", id: `user-${++serial}`, timestamp: `time-${serial}`, message: { role: "user", content: text } });
        persist();
        await beforeSend?.();
        if (failWorker) { idle = true; throw new Error("Worker failed after side effects"); }
        entries.push({ type: "message", id: `assistant-${++serial}`, timestamp: `time-${serial}`, message: { role: "assistant", provider: "openai", model: "sol", content: [{ type: "text", text: "Done" }], stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 0, cost: { total: 0.25 } } } });
        persist();
        idle = true;
      }),
    };
    chat.sessionManager = manager;
    ui.setEditorComponent(customFactory);
    return { orchestrator, ctx, pi, entries, persist, submitted, get editor() { return editor; }, id,
      setIdle: (value: boolean) => { idle = value; } };
  };
  current = create();
  current.orchestrator.start("startup", current.ctx);
  chat.rebuildChatFromMessages();
  const store = () => new RegistryStore(registryPath(workspace), workspace);
  const submit = async (text: string) => {
    const source = current;
    source.editor.onSubmit(text);
    const command = source.submitted.at(-1)!;
    source.editor.addToHistory(command);
    source.lastSubmittedHistory = [...source.editor.history];
    expect(command).toMatch(/^\/orchestrator __dispatch /);
    await source.orchestrator.command(command.slice("/orchestrator ".length), source.ctx);
    return source;
  };
  return { get current() { return current; }, chat, sent, submit, store,
    setFail: (value: boolean) => { failWorker = value; },
    setCancel: (value: boolean) => { cancelReplacement = value; },
    setBeforeSend: (callback: () => Promise<void>) => { beforeSend = callback; },
    externalSwitch: () => {
      current.orchestrator.shutdown("resume", current.ctx);
      current = create();
      current.orchestrator.start("resume", current.ctx);
    },
  };
}

describe("orchestrator integration", () => {
  it("offers help from the command and picker without enabling routing", async () => {
    const h = harness();
    await h.current.orchestrator.command("help", h.current.ctx);
    const help = h.current.ctx.ui.notify.mock.calls.at(-1)[0];
    for (const name of ["help", "new", "on", "off", "list", "status", "rename", "delete", "sessions", "attach", "compact", "drafts"]) {
      expect(help).toContain(`/orchestrator ${name}`);
    }
    expect(help).not.toContain("__dispatch");
    h.current.ctx.ui.select.mockResolvedValueOnce("Help — available commands");
    await h.current.orchestrator.command("", h.current.ctx);
    expect(h.current.ctx.ui.notify).toHaveBeenLastCalledWith(help, "info");
    expect(runtimeFor(workspace).enabled).toBe(false);
    expect(h.store().read().virtualSessions).toHaveLength(0);
  });

  it("deletes the selected group, restores the editor, and keeps transcripts and drafts", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    const file = h.current.ctx.sessionManager.getSessionFile();
    const before = readFileSync(file, "utf8");
    const state = runtimeFor(workspace);
    state.pending.set("unsent", { text: "Retained draft", virtualId: state.activeId! });
    await h.current.orchestrator.command("delete", h.current.ctx);
    expect(h.current.ctx.ui.confirm).toHaveBeenCalledWith("Delete orchestrator Atlas?", expect.stringContaining("transcripts are kept"));
    expect(h.store().read().virtualSessions).toEqual([]);
    expect(state.activeId).toBeUndefined();
    expect(state.enabled).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.pending.size).toBe(0);
    expect(state.heldDrafts).toContain("Retained draft");
    expect(h.current.ctx.ui.getEditorComponent()).toBeUndefined();
    expect(h.current.ctx.ui.setWidget).toHaveBeenLastCalledWith("wpi-orchestrator", undefined);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(h.current.ctx.switchSession).not.toHaveBeenCalled();
  });

  it("cancels deletion without changes and can delete an inactive group by name or ID", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    const activeId = runtimeFor(workspace).activeId;
    const factory = h.current.ctx.ui.getEditorComponent();
    const other = h.store().create("Other Project");
    const before = h.store().read();
    h.current.ctx.ui.confirm.mockResolvedValueOnce(false);
    await h.current.orchestrator.command('delete "Other Project"', h.current.ctx);
    expect(h.store().read()).toEqual(before);
    expect(runtimeFor(workspace).busy).toBe(false);
    await h.current.orchestrator.command(`delete ${other.id}`, h.current.ctx);
    expect(h.store().read().virtualSessions.map(item => item.id)).toEqual([activeId]);
    expect(runtimeFor(workspace).activeId).toBe(activeId);
    expect(runtimeFor(workspace).enabled).toBe(true);
    expect(h.current.ctx.ui.getEditorComponent()).toBe(factory);
  });

  it("rejects deletion without a target, while busy, or during another process's execution", async () => {
    const h = harness();
    await expect(h.current.orchestrator.command("delete", h.current.ctx)).rejects.toThrow("Select an orchestrator");
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    const state = runtimeFor(workspace);
    state.busy = true;
    await expect(h.current.orchestrator.command("delete", h.current.ctx)).rejects.toThrow("request is running");
    state.busy = false;
    const release = h.store().lease();
    try {
      await expect(h.current.orchestrator.command("delete", h.current.ctx)).rejects.toThrow("Another orchestrator");
      expect(h.store().read().virtualSessions).toHaveLength(1);
      expect(state.enabled).toBe(true);
      expect(state.busy).toBe(false);
    } finally { release(); }
  });

  it("hides inactive status while keeping explicit status available", async () => {
    const h = harness();
    const expectHidden = () => {
      expect(h.current.ctx.ui.setStatus).toHaveBeenLastCalledWith("wpi-orchestrator", undefined);
      expect(h.current.ctx.ui.setWidget).toHaveBeenLastCalledWith("wpi-orchestrator", undefined);
    };
    expectHidden();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    expect(h.current.ctx.ui.setWidget.mock.calls.at(-1)[1]).toBeTypeOf("function");
    await h.current.orchestrator.command("off", h.current.ctx);
    expectHidden();
    h.current.orchestrator.observe(h.current.ctx);
    expectHidden();
    await h.current.orchestrator.command("status", h.current.ctx);
    expect(h.current.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Routing: paused"), "info");
    expectHidden();
    await h.current.orchestrator.command("on Atlas", h.current.ctx);
    expect(h.current.ctx.ui.setWidget.mock.calls.at(-1)[1]).toBeTypeOf("function");
    h.externalSwitch();
    expectHidden();
  });

  it("creates a named virtual session without adopting the entry transcript, then routes original multiline text once", async () => {
    const h = harness();
    const entryId = h.current.id;
    await h.current.orchestrator.command('new "Project Atlas"', h.current.ctx);
    expect(h.store().read().members).toHaveLength(0);
    const original = "Implement OAuth\nExplain the literal command /orchestrator off";
    const source = await h.submit(original);
    expect(h.sent).toEqual([{ realId: h.current.id, text: original }]);
    expect(source.lastSubmittedHistory).toContain(original);
    expect(h.current.id).not.toBe(entryId);
    const data = h.store().read();
    expect(data.members[0].name).toBe("Project Atlas / Implement OAuth");
    expect(data.requests[0].state).toBe("completed");
    expect(data.usage[0].virtualId).toBe(data.virtualSessions[0].id);
    expect(runtimeFor(workspace).enabled).toBe(true);
    expect(h.sent[0].text).not.toContain("__dispatch");
  });

  it("keeps A → B → A history in main chat while real model contexts stay isolated", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    const firstId = h.current.id;
    await h.submit("Different task");
    expect(h.current.id).not.toBe(firstId);
    const displayedUsers = () => h.chat.displayed.messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
    expect(displayedUsers()).toEqual(["First task", "Different task"]);
    expect(h.current.entries.filter((entry: any) => entry.type === "message" && entry.message.role === "user").map((entry: any) => entry.message.content)).toEqual(["Different task"]);
    const first = h.store().read().members.find(member => member.id === firstId)!;
    h.current.ctx.ui.select.mockResolvedValueOnce(`Continue: ${first.name} [${firstId.slice(0, 8)}]`);
    await h.submit("Return to first task");
    expect(h.current.id).toBe(firstId);
    expect(displayedUsers()).toEqual(["First task", "Different task", "Return to first task"]);
    expect(h.current.entries.filter((entry: any) => entry.type === "message" && entry.message.role === "user").map((entry: any) => entry.message.content)).toEqual(["First task", "Return to first task"]);
    await h.current.orchestrator.command("off", h.current.ctx);
    expect(displayedUsers()).toEqual(["First task", "Return to first task"]);
    await h.current.orchestrator.command("on Atlas", h.current.ctx);
    expect(displayedUsers()).toEqual(["First task", "Different task", "Return to first task"]);
    await h.current.orchestrator.command("new Other", h.current.ctx);
    expect(displayedUsers()).toEqual([]);
    await h.current.orchestrator.command("on Atlas", h.current.ctx);
    expect(displayedUsers()).toEqual(["First task", "Different task", "Return to first task"]);
  });

  it("uses a configured decision model to reuse the same member and aggregates calls once", async () => {
    const backend: DecisionBackend = { evaluate: vi.fn(async (_text, candidates) => ({ decision: { action: "reuse" as const, realId: candidates[0].id, reason: "continued task" } })) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    const first = h.current.id;
    await h.submit("Now add tests for that");
    expect(backend.evaluate).toHaveBeenCalledOnce();
    expect(h.current.id).toBe(first);
    const data = h.store().read();
    expect(data.members).toHaveLength(1);
    expect(data.members[0].summary).toMatch(/^Latest turn:\nuser: Now add tests for that/);
    expect(data.members[0].summary).toContain("Implement OAuth");
    expect(vi.mocked(backend.evaluate).mock.calls[0][1][0].summary).toContain("Implement OAuth");
    expect(data.requests).toHaveLength(2);
    expect(data.usage.filter(item => item.category === "worker")).toHaveLength(2);
    expect(data.usage.filter(item => item.category === "decision")).toHaveLength(1);
    h.current.orchestrator.observe(h.current.ctx);
    expect(h.store().read().usage).toHaveLength(3);
  });

  it.each(["ambiguous", "unavailable"])("keeps the current session without a picker when the backend is %s", async mode => {
    const backend: DecisionBackend = { evaluate: vi.fn(async () => {
      if (mode === "unavailable") throw new Error("Backend unavailable");
      return { decision: { action: "clarify" as const, reason: "Uncertain" } };
    }) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    const firstId = h.current.id;
    await h.submit("Now add tests for that");
    expect(h.current.id).toBe(firstId);
    expect(h.current.ctx.ui.select).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(2);
    const data = h.store().read();
    expect(data.members).toHaveLength(1);
    expect(data.requests.at(-1)).toMatchObject({ state: "completed", realId: firstId });
    expect(data.requests.at(-1)?.reason).toContain("retained the current session");
    expect(data.usage.filter(item => item.category === "decision")).toHaveLength(1);
  });

  it("shows one line of virtual and active real costs after routing between sessions", async () => {
    const evaluate = vi.fn<DecisionBackend["evaluate"]>();
    const backend: DecisionBackend = { evaluate };
    const h = harness(backend);
    const infoLine = () => {
      const factory = h.current.ctx.ui.setWidget.mock.calls.at(-1)[1];
      const lines = factory({}, h.current.ctx.ui.theme).render(1000);
      expect(lines).toHaveLength(1);
      expect(h.current.ctx.ui.setStatus).toHaveBeenLastCalledWith("wpi-orchestrator", undefined);
      return lines[0];
    };
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    expect(infoLine()).toBe("Atlas · V ~$0.0000 · R ~$0.0000");
    await h.submit("Implement OAuth");
    const firstId = h.current.id;
    expect(infoLine()).toBe("Atlas · V ~$0.2500 ↑10 ↓2 R100 · R ~$0.2500 ↑10 ↓2 R100");
    evaluate.mockResolvedValueOnce({ decision: { action: "new", reason: "Independent task", confidence: 0.99, margin: 0.98 } });
    await h.submit("Set up Docker");
    expect(h.current.id).not.toBe(firstId);
    expect(infoLine()).toBe("Atlas · V partial $0.5000 ↑20 ↓4 R200 (partial tokens) · R ~$0.2500 ↑10 ↓2 R100");
    evaluate.mockResolvedValueOnce({ decision: { action: "reuse", realId: firstId, reason: "OAuth follow-up", confidence: 0.99, margin: 0.98 } });
    await h.submit("Add OAuth tests");
    expect(h.current.id).toBe(firstId);
    expect(infoLine()).toBe("Atlas · V partial $0.7500 ↑30 ↓6 R300 (partial tokens) · R ~$0.5000 ↑20 ↓4 R200");
  });

  it.each([
    { action: "new", reason: "Different keywords" },
    { action: "new", reason: "Moderately confident", confidence: 0.75, margin: 0.7 },
    { action: "new", reason: "Not quite strong enough", confidence: 0.7999, margin: 0.6 },
    { action: "new", reason: "Insufficient margin", confidence: 0.99, margin: 0.59 },
  ] as const)("keeps the current member when changing sessions is not strongly justified: $reason", async decision => {
    const backend: DecisionBackend = { evaluate: vi.fn(async () => ({ decision })) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    const firstId = h.current.id;
    await h.submit("A related implementation question");
    expect(h.current.id).toBe(firstId);
    expect(h.store().read().members).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
    expect(h.store().read().requests.at(-1)?.state).toBe("completed");
    expect(vi.mocked(backend.evaluate).mock.calls[0][1][0].isCurrent).toBe(true);
  });

  it("rejects weak automatic switches to another eligible member", async () => {
    const evaluate = vi.fn<DecisionBackend["evaluate"]>();
    const h = harness({ evaluate });
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    const firstId = h.current.id;
    evaluate.mockResolvedValueOnce({ decision: { action: "new", reason: "Requires isolation", confidence: 0.8, margin: 0.6 } });
    await h.submit("Independent task");
    const secondId = h.current.id;
    evaluate.mockResolvedValueOnce({ decision: { action: "reuse", realId: firstId, reason: "Similar keywords", confidence: 0.79, margin: 0.7 } });
    await h.submit("Add tests");
    expect(h.current.id).toBe(secondId);
    expect(h.store().read().members).toHaveLength(2);
  });

  it("updates the info line when switching to a different virtual session", async () => {
    const h = harness();
    const infoLines = () => {
      const factory = h.current.ctx.ui.setWidget.mock.calls.at(-1)[1];
      return factory({}, h.current.ctx.ui.theme).render(1000);
    };
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    const atlasRealId = h.current.id;
    expect(infoLines()).toEqual(["Atlas · V ~$0.2500 ↑10 ↓2 R100 · R ~$0.2500 ↑10 ↓2 R100"]);

    await h.current.orchestrator.command("new Lisbon weather", h.current.ctx);
    // Creating a virtual session does not adopt the still-active real session.
    expect(infoLines()).toEqual(["Lisbon weather · V ~$0.0000 · R ~$0.2500 ↑10 ↓2 R100"]);
    await h.submit("Check the rain in Lisbon");
    expect(h.current.id).not.toBe(atlasRealId);
    await h.current.orchestrator.command("compact", h.current.ctx);
    expect(infoLines()).toEqual(["Lisbon weather · V ~$0.2700 ↑15 ↓3 R100 · R ~$0.2700 ↑15 ↓3 R100"]);

    await h.current.orchestrator.command("on Atlas", h.current.ctx);
    expect(h.current.id).toBe(atlasRealId);
    expect(infoLines()).toEqual(["Atlas · V ~$0.2500 ↑10 ↓2 R100 · R ~$0.2500 ↑10 ↓2 R100"]);

    await h.current.orchestrator.command("on Lisbon weather", h.current.ctx);
    expect(infoLines()).toEqual(["Lisbon weather · V ~$0.2700 ↑15 ↓3 R100 · R ~$0.2700 ↑15 ↓3 R100"]);
  });

  it("provides reconciled lifetime usage and live/saved context for each routing candidate", async () => {
    const backend: DecisionBackend = { evaluate: vi.fn(async () => ({
      decision: { action: "new" as const, reason: "Independent task", confidence: 0.99, margin: 0.98 },
    })) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    const firstId = h.current.id;
    await h.submit("Set up Docker");
    await h.current.orchestrator.command("compact", h.current.ctx);
    const secondId = h.current.id;
    await h.submit("Review the deployment");
    const candidates = vi.mocked(backend.evaluate).mock.calls.at(-1)![1];
    expect(candidates.find(item => item.id === firstId)?.metrics).toEqual({
      lifetimeUsage: { input: 10, output: 2, cacheRead: 100, cacheWrite: 0,
        totalTokens: 112, cost: 0.25, incompleteTokens: false, incompleteCost: false },
      context: { tokens: 112, contextWindow: null, estimated: true },
    });
    expect(candidates.find(item => item.id === secondId)?.metrics).toEqual({
      lifetimeUsage: { input: 15, output: 3, cacheRead: 100, cacheWrite: 0,
        totalTokens: 118, cost: 0.27, incompleteTokens: false, incompleteCost: false },
      context: { tokens: 24, contextWindow: 200000, estimated: false },
    });
  });

  it("clarifies when no backend is configured and restores cancelled input", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    h.current.ctx.ui.select.mockResolvedValueOnce(undefined);
    await h.submit("What about Docker?");
    expect(h.sent).toHaveLength(1);
    expect(h.current.editor.getText()).toBe("What about Docker?");
    const choices = h.current.ctx.ui.select.mock.calls.at(-1)[1];
    expect(choices[0]).toContain(h.current.id.slice(0, 8));
    expect(choices.at(-1)).toBe("Create a new focused session");
    expect(h.store().read().requests.at(-1)?.state).toBe("interrupted");
    expect(h.store().read().usage.filter(item => item.category === "decision")).toHaveLength(0);
  });

  it("resumes the same virtual session from an unrelated real session without importing it", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    const memberId = h.current.id;
    h.externalSwitch();
    const unrelatedId = h.current.id;
    expect(runtimeFor(workspace).enabled).toBe(false);
    await h.current.orchestrator.command("on Atlas", h.current.ctx);
    expect(h.current.id).toBe(memberId);
    expect(h.current.id).not.toBe(unrelatedId);
    expect(h.store().read().members).toHaveLength(1);
    expect(runtimeFor(workspace).enabled).toBe(true);
  });

  it("wraps and restores an existing editor without replacing its implementation", async () => {
    const customFactory = vi.fn(() => new CustomEditor({} as any, {} as any, {} as any));
    const h = harness(undefined, customFactory);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    expect(customFactory).toHaveBeenCalledTimes(2);
    expect(h.current.ctx.ui.getEditorComponent()).not.toBe(customFactory);
    h.current.editor.setText("unsent draft");
    await h.current.orchestrator.command("off", h.current.ctx);
    expect(h.current.ctx.ui.getEditorComponent()).toBe(customFactory);
    expect(h.current.editor.getText()).toBe("unsent draft");
    h.current.editor.onSubmit("ordinary prompt");
    expect(h.current.submitted.at(-1)).toBe("ordinary prompt");
  });

  it("never clobbers a later editor factory", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    const later = () => new CustomEditor({} as any, {} as any, {} as any);
    h.current.ctx.ui.setEditorComponent(later);
    await h.current.orchestrator.command("off", h.current.ctx);
    expect(h.current.ctx.ui.getEditorComponent()).toBe(later);
  });

  it("keeps native commands and in-flight steering outside routing", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    h.current.editor.onSubmit("/model");
    expect(h.current.submitted.at(-1)).toBe("/model");
    h.current.setIdle(false);
    h.current.editor.onSubmit("steer this work");
    expect(h.current.submitted.at(-1)).toBe("steer this work");
    expect(runtimeFor(workspace).pending.size).toBe(0);
  });

  it("marks failed worker delivery interrupted, releases lease, and does not replay", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    h.setFail(true);
    await h.submit("Change a file");
    const request = h.store().read().requests[0];
    expect(request.state).toBe("interrupted");
    expect(h.sent).toHaveLength(1);
    expect(runtimeFor(workspace).busy).toBe(false);
    await expect(h.current.orchestrator.command(`__dispatch ${request.id}`, h.current.ctx)).rejects.toThrow("expired");
    expect(h.sent).toHaveLength(1);
    const release = h.store().lease();
    release();
  });

  it("does not dispatch after a cancelled replacement", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    h.setCancel(true);
    await h.submit("Implement OAuth");
    expect(h.sent).toHaveLength(0);
    expect(h.store().read().members).toHaveLength(0);
    expect(h.current.editor.getText()).toBe("Implement OAuth");
  });

  it("attaches an existing real session explicitly without its prior cost", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.current.ctx.sendUserMessage("Existing work");
    h.current.orchestrator.observe(h.current.ctx);
    const widget = h.current.ctx.ui.setWidget.mock.calls.at(-1)[1]({}, h.current.ctx.ui.theme);
    expect(widget.render(1000)).toEqual(["Atlas · V ~$0.0000 · R ~$0.2500 ↑10 ↓2 R100"]);
    await h.current.orchestrator.command("off", h.current.ctx);
    await h.current.orchestrator.command("attach Atlas", h.current.ctx);
    const data = h.store().read();
    expect(data.members[0].origin).toBe("attached");
    expect(data.members[0].baselineSources).toHaveLength(1);
    expect(data.usage[0].virtualId).toBeUndefined();
    await h.current.ctx.sendUserMessage("Further work");
    h.current.orchestrator.observe(h.current.ctx);
    expect(h.store().read().usage.filter(item => item.virtualId)).toHaveLength(1);
  });

  it("supports callback-based manual compaction and partial-token dashboards", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    await h.current.orchestrator.command("compact Preserve PKCE", h.current.ctx);
    expect(h.current.ctx.compact).toHaveBeenCalledWith(expect.objectContaining({ customInstructions: "Preserve PKCE" }));
    expect(h.store().read().usage.some(item => item.category === "summary")).toBe(true);
    await h.current.orchestrator.command("status", h.current.ctx);
    expect(h.current.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Current real contribution"), "info");
    const widget = h.current.ctx.ui.setWidget.mock.calls.at(-1)[1]({}, h.current.ctx.ui.theme);
    expect(widget.render(30).every((line: string) => line.length <= 30)).toBe(true);
  });

  it("restores a draft on lease contention without starting worker inference", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    const release = h.store().lease();
    await h.submit("Not yet delivered");
    expect(h.sent).toHaveLength(0);
    expect(h.current.editor.getText()).toBe("Not yet delivered");
    expect(h.store().read().requests).toHaveLength(0);
    release();
  });

  it("honors off during classification instead of re-enabling routing", async () => {
    let finish!: (value: DecisionResult) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const backend: DecisionBackend = { evaluate: vi.fn(async () => {
      started();
      return new Promise<DecisionResult>(resolve => { finish = resolve; });
    }) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    const next = h.submit("Another task");
    await began;
    await h.current.orchestrator.command("off", h.current.ctx);
    finish({ decision: { action: "new", reason: "independent" } });
    await next;
    expect(h.sent).toHaveLength(1);
    expect(runtimeFor(workspace).enabled).toBe(false);
    expect(h.current.editor.getText()).toBe("Another task");
  });

  it("does not dispatch backend-selected sessions outside the shortlist", async () => {
    const backend: DecisionBackend = { evaluate: vi.fn(async () => ({ decision: { action: "reuse" as const, realId: "arbitrary-file", reason: "invalid" } })) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    await h.submit("Follow-up");
    expect(h.sent).toHaveLength(1);
    expect(h.current.editor.getText()).toBe("Follow-up");
    expect(h.store().read().requests.at(-1)?.state).toBe("interrupted");
  });

  it("redacts direct classifier inputs before calling an optional backend", async () => {
    vi.stubEnv("WPI_ORCHESTRATOR_DECISION_API_KEY", "routing-secret-example-value-123456");
    const backend: DecisionBackend = { evaluate: vi.fn(async () => ({ decision: { action: "new" as const, reason: "independent" } })) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    await h.submit("Check routing-secret-example-value-123456");
    expect(backend.evaluate).toHaveBeenCalledOnce();
    const sentToClassifier = vi.mocked(backend.evaluate).mock.calls[0][0];
    expect(sentToClassifier).not.toContain("routing-secret-example-value-123456");
    expect(sentToClassifier).toContain("__WPI_SECRET_");
  });

  it("holds an additional idle submission during routing rather than sending it to the wrong task", async () => {
    let finish!: (value: DecisionResult) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const backend: DecisionBackend = { evaluate: vi.fn(async () => {
      started();
      return new Promise<DecisionResult>(resolve => { finish = resolve; });
    }) };
    const h = harness(backend);
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("First task");
    const routing = h.submit("Second task");
    await began;
    await h.submit("Held draft");
    expect(h.current.editor.getText()).toBe("Held draft");
    expect(h.sent).toHaveLength(1);
    finish({ decision: { action: "reuse", realId: h.current.id, reason: "continuation" } });
    await routing;
    expect(h.sent).toHaveLength(2);
    expect(h.sent.some(item => item.text === "Held draft")).toBe(false);
    expect(h.current.editor.getText()).toBe("Held draft");
    expect(runtimeFor(workspace).heldDrafts).toEqual(["Held draft"]);
  });

  it("does not accept fabricated internal commands or route RPC clients", async () => {
    const h = harness();
    await expect(h.current.orchestrator.command("__dispatch nonexistent", h.current.ctx)).rejects.toThrow("Invalid");
    await expect(h.current.orchestrator.command("new Atlas", { ...h.current.ctx, mode: "rpc" })).rejects.toThrow("terminal editor");
    expect(h.sent).toHaveLength(0);
  });
});

it("parses quoted names and multiline arguments without shell execution", () => {
  expect(parseCommand('new "Project Atlas"')).toEqual({ action: "new", argument: "Project Atlas" });
  expect(parseCommand("compact preserve\nidentifiers")).toEqual({ action: "compact", argument: "preserve\nidentifiers" });
});

it("loads the extension without network requests or creating persistent state", () => {
  const pi: any = { registerCommand: vi.fn(), registerTool: vi.fn(), on: vi.fn() };
  vi.stubEnv("WPI_ORCHESTRATOR_DECISION_URL", "file:///invalid");
  expect(() => extension(pi)).not.toThrow();
  expect(pi.registerCommand).toHaveBeenCalledWith("orchestrator", expect.any(Object));
  const command = pi.registerCommand.mock.calls[0][1];
  expect(command.getArgumentCompletions("").map((item: any) => item.value)).toContain("help");
  expect(command.getArgumentCompletions("st")).toEqual([
    { value: "status", label: "status", description: expect.any(String) },
  ]);
  expect(command.getArgumentCompletions("__dispatch")).toBeNull();
  expect(command.getArgumentCompletions("new Atlas")).toBeNull();
  expect(pi.on.mock.calls.map((call: any[]) => call[0])).toContain("session_start");
});
