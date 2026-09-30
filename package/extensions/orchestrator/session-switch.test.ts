import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionSwitch } from "./session-switch";
import type { DeferredActionGate } from "./compaction";

function fixture(supported = true) {
  const handlers = new Map<string, Function>();
  let tool: any;
  let idle = false;
  const gate: DeferredActionGate = {};
  const ctx: any = { cwd: "/tmp", sessionManager: { getSessionId: () => "source" }, isIdle: () => idle, hasPendingMessages: () => false };
  const orchestrator: any = {
    scheduleSwitch: vi.fn().mockReturnValue("opaque"), cancelSwitch: vi.fn(), compactionEnabled: () => true, switchPending: () => true,
    switchCandidates: () => [{ id: "target", name: "OAuth", summary: "PKCE tests" }],
  };
  const pi: any = { registerTool: (value: any) => { tool = value; }, on: (name: string, handler: Function) => handlers.set(name, handler), sendUserMessage: vi.fn() };
  const controller = installSessionSwitch(pi, orchestrator, gate, supported);
  return { gate, ctx, pi, orchestrator, controller,
    call: () => tool.execute("call", { target_session_id: "target", reason: "unique context needed", preservation_notes: "PKCE" }, undefined, undefined, ctx),
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
    setIdle: () => { idle = true; },
  };
}
afterEach(() => vi.useRealTimers());

describe("deferred session-switch tool", () => {
  it("returns scheduled before invoking the command-capable dispatcher", async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect((await f.call()).details.status).toBe("scheduled");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    f.emit("agent_settled");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    f.setIdle();
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).toHaveBeenCalledWith("/orchestrator __dispatch opaque", { expandPromptTemplates: true });
  });
  it.each(["input", "before_agent_start", "session_start", "session_shutdown", "session_tree", "session_compact"])("cancels queued commands on %s", async event => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.emit(event);
    f.setIdle();
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.orchestrator.cancelSwitch).toHaveBeenCalledWith("opaque", f.ctx);
    expect(f.gate.owner).toBeUndefined();
  });
  it("rejects a switch while compaction or another switch is pending", async () => {
    const f = fixture();
    f.gate.owner = "compact";
    await expect(f.call()).rejects.toThrow("already pending");
    f.gate.owner = undefined;
    await f.call();
    await expect(f.call()).rejects.toThrow("already pending");
  });
  it("dispatches a request only once and releases the gate after command completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.emit("agent_settled");
    f.setIdle();
    vi.runAllTimers();
    f.emit("agent_settled");
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).toHaveBeenCalledOnce();
    f.controller.finishDispatch("opaque");
    expect(f.gate.owner).toBeUndefined();
  });
  it("does not dispatch a model request superseded by an editor submission", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.orchestrator.switchPending = () => false;
    f.setIdle();
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("requires final-settlement and command-dispatch support", async () => {
    const f = fixture(false);
    await expect(f.call()).rejects.toThrow("0.99.1+");
    expect(f.emit("context", { messages: [] })).toBeUndefined();
  });
  it("exposes existing member IDs without replacing the system prompt", () => {
    const f = fixture();
    const result = f.emit("context", { messages: [] });
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain('"id":"target"');
  });
  it("does not dispatch while input is queued", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call();
    f.emit("agent_settled");
    f.ctx.hasPendingMessages = () => true;
    f.setIdle();
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.gate.owner).toBeUndefined();
  });
});
