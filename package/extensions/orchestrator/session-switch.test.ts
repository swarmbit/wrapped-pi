import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionSwitch } from "./session-switch";
import type { DeferredActionGate } from "./compaction";

function fixture(supported = true) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let idle = false;
  const gate: DeferredActionGate = {};
  const ctx: any = { cwd: "/tmp", sessionManager: { getSessionId: () => "source" }, isIdle: () => idle, hasPendingMessages: () => false };
  const orchestrator: any = {
    scheduleSwitch: vi.fn().mockReturnValue("opaque"), scheduleNewSession: vi.fn().mockReturnValue("opaque"),
    listSessions: vi.fn(() => [{ id: "source", name: "Current", isCurrent: true, summary: "Current work" },
      { id: "target", name: "OAuth", isCurrent: false, summary: "PKCE tests" }]),
    cancelSwitch: vi.fn(), compactionEnabled: () => true, switchPending: () => true,
    switchCandidates: () => [{ id: "target", name: "OAuth", summary: "PKCE tests" }],
  };
  const pi: any = { registerTool: (value: any) => { tools.set(value.name, value); }, on: (name: string, handler: Function) => handlers.set(name, handler), sendUserMessage: vi.fn() };
  const controller = installSessionSwitch(pi, orchestrator, gate, supported);
  return { gate, ctx, pi, orchestrator, controller,
    call: () => tools.get("request_session_switch").execute("call", { target_session_id: "target", reason: "unique context needed", preservation_notes: "PKCE" }, undefined, undefined, ctx),
    create: () => tools.get("request_new_session").execute("call", { reason: "Distinct task", preservation_notes: "" }, undefined, undefined, ctx),
    list: (args: any = {}) => tools.get("list_sessions").execute("call", args, undefined, undefined, ctx),
    emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
    setIdle: () => { idle = true; },
  };
}
afterEach(() => vi.useRealTimers());

describe("deferred session-switch tool", () => {
  it("lists current and other members with bounded summaries and pagination", async () => {
    const f = fixture();
    f.orchestrator.listSessions.mockReturnValue(Array.from({ length: 12 }, (_, index) => ({
      id: `member-${index}`, name: "Task", isCurrent: index === 0, summary: JSON.stringify([{ role: "user", content: "x".repeat(13000) }]),
    })));
    const first = await f.list();
    expect(first.details.sessions).toHaveLength(10);
    expect(first.details.next_offset).toBe(10);
    expect(first.details.sessions[0]).toMatchObject({ isCurrent: true, summary_truncated: true });
    expect(first.details.sessions[0].summary).toHaveLength(2000);
    expect((await f.list({ offset: 10 })).details.sessions).toHaveLength(2);
    expect((await f.list({ session_id: "member-3" })).details.sessions[0].summary).toHaveLength(12000);
    await expect(f.list({ session_id: "outside" })).rejects.toThrow("active virtual session");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });
  it("defers creation through the same safe command dispatcher", async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect((await f.create()).details.action).toBe("new");
    expect(f.orchestrator.scheduleNewSession).toHaveBeenCalledWith("Distinct task", "", f.ctx);
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    await expect(f.call()).rejects.toThrow("already pending");
    f.emit("agent_settled");
    f.setIdle();
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).toHaveBeenCalledWith("/orchestrator __dispatch opaque", { expandPromptTemplates: true });
  });
  it.each(["input", "session_start", "session_shutdown", "session_tree", "session_compact"])("cancels new-session requests on %s", async event => {
    vi.useFakeTimers();
    const f = fixture();
    await f.create();
    f.emit("agent_settled");
    f.emit(event);
    f.setIdle();
    vi.runAllTimers();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.gate.owner).toBeUndefined();
  });
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
  it("does not inject session members or routing reminders into context", () => {
    const f = fixture();
    const messages = [{ role: "user", content: "Continue" }];
    expect(f.emit("context", { messages })).toBeUndefined();
    expect(messages).toEqual([{ role: "user", content: "Continue" }]);
    expect(f.orchestrator.listSessions).not.toHaveBeenCalled();
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
