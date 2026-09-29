import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionBackend, DecisionResult } from "./decision";
import { registryPath, RegistryStore } from "./store";
import { runtimeFor } from "./runtime";

vi.mock("@earendil-works/pi-coding-agent", () => ({
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
import { CustomEditor } from "@earendil-works/pi-coding-agent";

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

  const create = (id: string = randomUUID()) => {
    let alive = true;
    let idle = true;
    const entries: any[] = [];
    const file = join(workspace, `${id}.jsonl`);
    const assertAlive = () => { if (!alive) throw new Error("STALE CONTEXT"); };
    const persist = () => writeFileSync(file, [{ type: "session", version: 3, id, cwd: workspace }, ...entries].map(item => JSON.stringify(item)).join("\n") + "\n");
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
        editor = next ? next({}, {}, {}) : new CustomEditor({} as any, {} as any, {} as any);
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
    ui.setEditorComponent(customFactory);
    return { orchestrator, ctx, pi, entries, persist, submitted, get editor() { return editor; }, id,
      setIdle: (value: boolean) => { idle = value; } };
  };
  current = create();
  current.orchestrator.start("startup", current.ctx);
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
  return { get current() { return current; }, sent, submit, store,
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
    expect(data.requests).toHaveLength(2);
    expect(data.usage.filter(item => item.category === "worker")).toHaveLength(2);
    expect(data.usage.filter(item => item.category === "decision")).toHaveLength(1);
    h.current.orchestrator.observe(h.current.ctx);
    expect(h.store().read().usage).toHaveLength(3);
  });

  it("clarifies when no backend is configured and restores cancelled input", async () => {
    const h = harness();
    await h.current.orchestrator.command("new Atlas", h.current.ctx);
    await h.submit("Implement OAuth");
    h.current.ctx.ui.select.mockResolvedValueOnce(undefined);
    await h.submit("What about Docker?");
    expect(h.sent).toHaveLength(1);
    expect(h.current.editor.getText()).toBe("What about Docker?");
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
  const pi: any = { registerCommand: vi.fn(), on: vi.fn() };
  vi.stubEnv("WPI_ORCHESTRATOR_DECISION_URL", "file:///invalid");
  expect(() => extension(pi)).not.toThrow();
  expect(pi.registerCommand).toHaveBeenCalledWith("orchestrator", expect.any(Object));
  expect(pi.on.mock.calls.map((call: any[]) => call[0])).toContain("session_start");
});
