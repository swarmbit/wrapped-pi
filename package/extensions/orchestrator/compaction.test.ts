import { afterEach, describe, expect, it, vi } from "vitest";
import { installCompaction, supportsDeferredCompaction } from "./compaction";

function fixture(supported = true) {
  const handlers = new Map<string, Function>();
  let tool: any;
  let enabled = true;
  let tokens: number | null = 50_000;
  let idle = false;
  let queued = false;
  let session = "one";
  const branch: any[] = Array.from({ length: 10 }, (_, i) => ({ type: "message", id: String(i), message: { role: "assistant", stopReason: "stop" } }));
  const ctx: any = {
    sessionManager: { getSessionId: () => session, getBranch: () => branch },
    getContextUsage: () => ({ tokens, contextWindow: 200_000 }),
    isIdle: () => idle, hasPendingMessages: () => queued, hasUI: true,
    ui: { notify: vi.fn() }, compact: vi.fn(),
  };
  const pi: any = { registerTool: (value: any) => { tool = value; }, on: (name: string, handler: Function) => handlers.set(name, handler) };
  installCompaction(pi, () => enabled, { interval: 10, minTokens: 30_000, supported });
  return {
    ctx, branch, handlers, tool,
    call: () => tool.execute("call", { reason: "Milestone complete", preservation_notes: "Keep PKCE and remaining tests" }, undefined, undefined, ctx),
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
    setIdle: (value: boolean) => { idle = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    setTokens: (value: number | null) => { tokens = value; },
    setQueued: (value: boolean) => { queued = value; },
    setSession: (value: string) => { session = value; },
  };
}

afterEach(() => vi.useRealTimers());

describe("deferred model-requested compaction", () => {
  it("requires final-settlement support", async () => {
    expect(supportsDeferredCompaction("0.79.1")).toBe(false);
    expect(supportsDeferredCompaction("0.99.0")).toBe(false);
    expect(supportsDeferredCompaction("0.99.1")).toBe(true);
    const f = fixture(false);
    await expect(f.call()).rejects.toThrow("unavailable");
    expect(f.handlers.has("agent_settled")).toBe(false);
  });

  it("returns a tool result before compaction and only runs after settled becomes idle", async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect((await f.call()).details.status).toBe("scheduled");
    expect(f.ctx.compact).not.toHaveBeenCalled();
    await expect(f.call()).rejects.toThrow("already pending");
    f.emit("agent_settled");
    expect(f.ctx.compact).not.toHaveBeenCalled();
    f.setIdle(true);
    vi.runAllTimers();
    expect(f.ctx.compact).toHaveBeenCalledTimes(1);
    const options = f.ctx.compact.mock.calls[0][0];
    expect(options.customInstructions).toContain("Keep PKCE");
    await expect(f.call()).rejects.toThrow("unavailable");
    f.branch.push({ type: "compaction" });
    f.emit("session_compact");
    options.onComplete();
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("completed"), "info");
    await expect(f.call()).rejects.toThrow("unavailable");
  });

  it.each(["input", "before_agent_start", "session_start", "session_shutdown", "session_tree", "session_compact"])("cancels deferred work on %s, even after scheduling", async event => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.emit(event);
    f.setIdle(true);
    vi.runAllTimers();
    expect(f.ctx.compact).not.toHaveBeenCalled();
  });

  it.each(["busy", "queued", "disabled", "changed", "aborted"])("does not compact when %s", async state => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.setIdle(state !== "busy");
    if (state === "queued") f.setQueued(true);
    if (state === "disabled") f.setEnabled(false);
    if (state === "changed") f.setSession("two");
    if (state === "aborted") f.ctx.signal = { aborted: true };
    vi.runAllTimers();
    expect(f.ctx.compact).not.toHaveBeenCalled();
  });

  it("enforces token and turn gates and throttles request-local reminders", async () => {
    const f = fixture();
    const event = { messages: [{ role: "user", content: "task" }] };
    expect(f.emit("context", event).messages).toHaveLength(2);
    expect(event.messages).toHaveLength(1);
    expect(f.emit("context", event)).toBeUndefined();
    f.emit("before_agent_start");
    expect(f.emit("context", event)).toBeUndefined();
    f.branch.push(...Array.from({ length: 10 }, () => ({ type: "message", message: { role: "assistant", stopReason: "stop" } })));
    expect(f.emit("context", event).messages).toHaveLength(2);
    f.setTokens(null);
    await expect(f.call()).rejects.toThrow("unavailable");
    f.setTokens(10_000);
    await expect(f.call()).rejects.toThrow("unavailable");
    f.setTokens(50_000);
    f.branch.push({ type: "compaction" });
    await expect(f.call()).rejects.toThrow("unavailable");
  });

  it("reports failure separately without claiming success in the tool result", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.setIdle(true);
    vi.runAllTimers();
    f.ctx.compact.mock.calls[0][0].onError(new Error("provider failed"));
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("provider failed"), "error");
    await expect(f.call()).resolves.toHaveProperty("details.status", "scheduled");
  });
});
