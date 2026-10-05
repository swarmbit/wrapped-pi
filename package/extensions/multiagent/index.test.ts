import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runtimes: [] as any[] }));
vi.mock("./runtime.js", () => ({
  MultiagentRuntime: class {
    children = new Map();
    constructor(_directory: any, _persist: any, _dialog: any, _factory: any, public onMail: any) { mocks.runtimes.push(this); }
    restore() {} subscribe(listener: () => void) { this.listener = listener; } listener?: () => void; async dispose() {}
  },
  lastAssistantText: () => "",
  childSessionCost: (child: any) => child.messages.some((message: any) => typeof message.usage?.cost?.total === "number")
    ? child.messages.reduce((total: number, message: any) => total + (message.usage?.cost?.total ?? 0), 0) : undefined,
}));
vi.mock("../secret-redaction/state.js", () => ({ redactForLlm: (value: any) => ({ ...value, text: value.text?.replace("sensitive-value", "MASKED") }) }));
import extension from "./index.js";
import { INCOMING_MAIL } from "./mailbox.js";
import { LIFECYCLE_ENTRY } from "./lifecycle.js";
afterEach(() => { vi.unstubAllEnvs(); mocks.runtimes.length = 0; });
const outgoing = { id: "12345678-1234-1234-1234-123456789abc", kind: "question", text: "Need sensitive-value?" };
function harness(branch: any[] = []) {
  vi.stubEnv("WPI_MULTIAGENT_CHILD", "0");
  const tools: Record<string, any> = {}; const events: Record<string, any> = {}; const commands: Record<string, any> = {};
  const messageRenderers: Record<string, any> = {}; const entryRenderers: Record<string, any> = {};
  const entries: any[] = []; const sendMessage = vi.fn();
  const api = { registerTool: (tool: any) => tools[tool.name] = tool, registerCommand: (name: string, command: any) => commands[name] = command,
    registerMessageRenderer: (name: string, renderer: any) => messageRenderers[name] = renderer,
    registerEntryRenderer: (name: string, renderer: any) => entryRenderers[name] = renderer,
    on: (name: string, callback: any) => events[name] = callback, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), sendMessage };
  let sessionId = "parent";
  const ctx = { cwd: "/tmp", mode: "tui", hasUI: true, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() }, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
  extension(api as any);
  return { tools, events, commands, messageRenderers, entryRenderers, entries, sendMessage, ctx, setSessionId: (id: string) => { sessionId = id; } };
}
describe("multiagent tool rendering", () => {
  it("renders read/list/ack/send calls and results as readable text", () => {
    const tool = harness().tools.multiagent;
    const theme = { fg: (_color: string, text: string) => text };
    const call = (args: any) => tool.renderCall(args, theme).render(120).join("\n").split("\n").map((line: string) => line.trimEnd()).join("\n");
    const result = (details: any) => tool.renderResult({ details, content: [{ type: "text", text: JSON.stringify(details) }] },
      { expanded: false, isPartial: false }, theme).render(120).join("\n").split("\n").map((line: string) => line.trimEnd()).join("\n");
    expect(call({ action: "start", agent: "runner", task: "Inspect the tests" })).toContain("Start runner: Inspect the tests");
    expect(call({ action: "read", id: "abc" })).toContain("Read abc");
    expect(call({ action: "list" })).toContain("List agents");
    expect(call({ action: "ack", messageId: "child:mail" })).toContain("Acknowledge child:mail");
    expect(call({ action: "send", id: "abc", message: "Continue" })).toContain("Send to abc: Continue");
    expect(result({ id: "abc", agent: "runner", status: "idle", text: "Finished work", truncated: false })).toContain("runner · abc · idle\nFinished work");
    expect(result([{ id: "abc", agent: "runner", status: "running", queued: 1 }])).toContain("runner · abc · running · 1 queued");
    expect(result({ messageId: "child:mail", acknowledged: true })).toContain("Acknowledged child:mail");
    expect(result({ messageId: "child:mail", acknowledged: false })).toContain("Could not acknowledge child:mail");
    expect(result({ id: "abc", agent: "runner", status: "running", queued: 0 })).toContain("runner abc: running");
  });
  it("handles empty, malformed, partial, and expanded results safely", () => {
    const tool = harness().tools.multiagent;
    const theme = { fg: (_color: string, text: string) => text };
    const render = (details: any, text = "") => tool.renderResult({ details, content: [{ type: "text", text }] },
      { expanded: false, isPartial: false }, theme).render(80).join("\n").split("\n").map((line: string) => line.trimEnd()).join("\n");
    expect(render([])).toContain("No agents");
    expect(render(undefined, "not-json")).toContain("not-json");
    expect(render(undefined)).toContain("Completed");
    const errorText = tool.renderResult({ isError: true, details: { error: "Unknown child" }, content: [{ type: "text", text: "Unknown child" }] },
      { expanded: false, isPartial: false }, theme).render(80).join("\n");
    expect(errorText).toContain("Unknown child");
    const errorDetails = tool.renderResult({ details: { error: "Cannot reconnect" }, content: [{ type: "text", text: "{}" }] },
      { expanded: false, isPartial: false }, theme).render(80).join("\n");
    expect(errorDetails).toContain("Cannot reconnect");
    expect(tool.renderResult({ details: {}, content: [] }, { expanded: false, isPartial: true }, theme).render(80).join("\n")).toContain("Working");
    const expanded = tool.renderResult({ details: { id: "a", agent: "runner", status: "idle", text: "line one\nline two" }, content: [] },
      { expanded: true, isPartial: false }, theme).render(80).join("\n").split("\n").map((line: string) => line.trimEnd()).join("\n");
    expect(expanded).toContain("line one\nline two");
    const collapsed = tool.renderResult({ details: { id: "a", agent: "runner", status: "idle", text: `one\ntwo\nthree\nfour`, truncated: true }, content: [] },
      { expanded: false, isPartial: false }, theme).render(80).join("\n");
    expect(collapsed).toContain("response truncated");
    expect(collapsed).toContain("expand");
  });
});

describe("parent live agent roster", () => {
  it("updates a non-history widget with active states, model, and session cost; records terminal transitions once", async () => {
    const h = harness(); await h.events.session_start({}, h.ctx);
    expect(h.messageRenderers[INCOMING_MAIL]).toBeDefined(); expect(h.entryRenderers[LIFECYCLE_ENTRY]).toBeDefined();
    const runtime = mocks.runtimes[0];
    const child: any = { id: "a1", agent: "runner", cwd: "/tmp", sessionFile: "/tmp/a1.jsonl", model: "requested/model",
      status: "running", queue: { steering: [], followUp: [] }, messages: [{ role: "assistant", provider: "openai", model: "actual-model", content: [], usage: { cost: { total: 0.1234 } } }], tools: new Map() };
    runtime.children.set(child.id, child);
    runtime.children.set("restored", { id: "restored", agent: "expert", status: "saved", messages: [], queue: { steering: [], followUp: [] } });
    runtime.listener();
    let widget = h.ctx.ui.setWidget.mock.calls.at(-1)!;
    expect(widget[0]).toBe("multiagent-agents"); expect(widget[1].join("\n")).toContain("runner:a1 · running · openai/actual-model · $0.1234");
    expect(widget[1].join("\n")).toContain("expert:restored · unknown (restored) · model unknown · cost unknown");
    child.status = "idle"; runtime.listener();
    widget = h.ctx.ui.setWidget.mock.calls.at(-1)!;
    expect(widget[1].join("\n")).toContain("runner:a1 · idle");
    expect(h.entries.filter(entry => entry.customType === LIFECYCLE_ENTRY)).toHaveLength(0);
    child.status = "failed"; child.error = "provider failed"; runtime.listener();
    const lifecycle = h.entries.find(entry => entry.customType === LIFECYCLE_ENTRY)!;
    expect(lifecycle.data).toMatchObject({ action: "failed", agent: "runner", error: "provider failed" });
    const card = h.entryRenderers[LIFECYCLE_ENTRY]({ data: lifecycle.data }, { expanded: false }, {
      fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
    }).render(80).join("\n");
    expect(card).toContain("Agent failed"); expect(card).toContain("provider failed");
    child.status = "failed"; runtime.listener();
    expect(h.entries.filter(entry => entry.customType === LIFECYCLE_ENTRY)).toHaveLength(1);
    await h.events.session_shutdown();
    expect(h.ctx.ui.setWidget.mock.calls.at(-1)).toEqual(["multiagent-agents", undefined]);
  });

  it("ignores stale child status callbacks after switching parent sessions", async () => {
    const h = harness(); await h.events.session_start({}, h.ctx);
    const oldRuntime = mocks.runtimes[0];
    const child = { id: "a1", agent: "runner", cwd: "/tmp", sessionFile: "/tmp/a1.jsonl", status: "running",
      messages: [], queue: { steering: [], followUp: [] }, tools: new Map() };
    oldRuntime.children.set(child.id, child); oldRuntime.listener();
    const entries = h.entries.length; h.setSessionId("other-parent");
    await h.events.session_start({}, h.ctx);
    const widgetCalls = h.ctx.ui.setWidget.mock.calls.length;
    child.status = "failed"; oldRuntime.listener();
    expect(h.entries).toHaveLength(entries); expect(h.ctx.ui.setWidget).toHaveBeenCalledTimes(widgetCalls);
    await h.events.session_shutdown();
  });
});

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
  it("files mail replayed from a child's history as unread without starting a parent turn", async () => {
    const h = harness(); await h.events.session_start({}, h.ctx);
    mocks.runtimes[0].onMail({ id: "child", agent: "runner" }, outgoing, true);
    expect(h.sendMessage).not.toHaveBeenCalled();
    const result = await h.tools.multiagent.execute("call", { action: "inbox" }, undefined, undefined, h.ctx);
    expect(result.details.unread).toBe(1);
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
