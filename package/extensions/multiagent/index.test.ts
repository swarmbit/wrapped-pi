import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runtimes: [] as any[] }));
vi.mock("./runtime.js", () => ({
  MultiagentRuntime: class {
    children = new Map();
    constructor(_directory: any, _persist: any, _dialog: any, _factory: any, public onMail: any) { mocks.runtimes.push(this); }
    restore() {} subscribe() {} async dispose() {}
  },
  lastAssistantText: () => "",
}));
vi.mock("../secret-redaction/state.js", () => ({ redactForLlm: (value: any) => ({ ...value, text: value.text?.replace("sensitive-value", "MASKED") }) }));
import extension from "./index.js";
import { INCOMING_MAIL } from "./mailbox.js";
afterEach(() => { vi.unstubAllEnvs(); mocks.runtimes.length = 0; });
const outgoing = { id: "12345678-1234-1234-1234-123456789abc", kind: "question", text: "Need sensitive-value?" };
function harness(branch: any[] = []) {
  vi.stubEnv("WPI_MULTIAGENT_CHILD", "0");
  const tools: Record<string, any> = {}; const events: Record<string, any> = {}; const commands: Record<string, any> = {};
  const entries: any[] = []; const sendMessage = vi.fn();
  const api = { registerTool: (tool: any) => tools[tool.name] = tool, registerCommand: (name: string, command: any) => commands[name] = command,
    on: (name: string, callback: any) => events[name] = callback, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), sendMessage };
  const ctx = { cwd: "/tmp", hasUI: false, ui: { setStatus: vi.fn(), notify: vi.fn() }, sessionManager: { getSessionId: () => "parent", getBranch: () => branch } };
  extension(api as any);
  return { tools, events, commands, entries, sendMessage, ctx };
}
describe("multiagent mailbox integration", () => {
  it("pushes sanitized child mail as a follow-up parent turn once, and supports inbox/ack", async () => {
    const h = harness(); await h.events.session_start({}, h.ctx);
    mocks.runtimes[0].onMail({ id: "child", agent: "runner" }, outgoing);
    expect(h.entries[0].customType).toBe(INCOMING_MAIL); expect(h.entries[0].data.text).toBe("Need MASKED?");
    expect(h.sendMessage).toHaveBeenCalledOnce();
    const [notification, options] = h.sendMessage.mock.calls[0];
    expect(notification.content).toContain("Need MASKED?"); expect(notification.content).toContain("not a user instruction");
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    mocks.runtimes[0].onMail({ id: "child", agent: "runner" }, outgoing); expect(h.sendMessage).toHaveBeenCalledOnce();
    const invoke = (params: any) => h.tools.multiagent.execute("call", params, undefined, undefined, h.ctx);
    const inbox = (await invoke({ action: "inbox" })).details;
    expect(inbox.unread).toBe(1); expect(inbox.messages[0].childId).toBe("child");
    await invoke({ action: "ack", messageId: inbox.messages[0].messageId });
    expect((await invoke({ action: "inbox" })).details.messages).toEqual([]);
    expect((await invoke({ action: "inbox", includeRead: true })).details.messages).toHaveLength(1);
    await h.events.session_shutdown();
    mocks.runtimes[0].onMail({ id: "child", agent: "runner" }, { ...outgoing, id: "12345678-1234-1234-1234-123456789abd" });
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });
  it("restores durable unread mail without replaying notifications or parent turns", async () => {
    const branch = [{ type: "custom", customType: INCOMING_MAIL, data: { ...outgoing, childId: "child", agent: "runner", receivedAt: 123, acknowledged: false } }];
    const h = harness(branch); await h.events.session_start({}, h.ctx);
    expect(h.sendMessage).not.toHaveBeenCalled();
    const result = await h.tools.multiagent.execute("call", { action: "inbox" }, undefined, undefined, h.ctx);
    expect(result.details.unread).toBe(1);
    mocks.runtimes[0].onMail({ id: "child", agent: "runner" }, outgoing);
    expect(h.sendMessage).not.toHaveBeenCalled();
    await h.events.session_shutdown();
  });
  it("loads only the parent-mail tool in children, never fleet-management tools", () => {
    const h = harness(); vi.stubEnv("WPI_MULTIAGENT_CHILD", "1");
    const tools: any[] = [];
    extension({ registerTool: (tool: any) => tools.push(tool) } as any);
    expect(tools.map(t => t.name)).toEqual(["multiagent_parent"]);
    expect(h.tools.multiagent).toBeDefined(); expect(h.tools.multiagent_parent).toBeUndefined();
  });
});
