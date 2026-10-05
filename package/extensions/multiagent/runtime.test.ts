import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { childSessionCost, MultiagentRuntime, lastAssistantText, type ChildRecord, type TransportFactory } from "./runtime.js";
import type { AgentConfig } from "../subagent/agents.js";

const agent: AgentConfig = { name: "runner", description: "Test", source: "user", filePath: "/agent.md", systemPrompt: "Original instructions", tools: ["read"], model: "test/model" };
const directories: string[] = [];
const runtimes: MultiagentRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.dispose())); await Promise.all(directories.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
async function setup(onMail?: (child: any, mail: any) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multiagent-test-")); directories.push(directory);
  const records: ChildRecord[] = [];
  const processes: { args: string[]; emit: (event: any) => void; exit: (error: Error) => void; calls: any[]; responses: any[]; closed: boolean; failPrompt: boolean }[] = [];
  const factory: TransportFactory = (_cwd, args, emit, exit) => {
    const process = { args, emit, exit, calls: [] as any[], responses: [] as any[], closed: false, failPrompt: false }; processes.push(process);
    return {
      async request(type, fields = {}) {
        process.calls.push({ type, ...fields });
        if (type === "get_messages") return { messages: [] };
        if (type === "prompt") { if (process.failPrompt) throw new Error("rejected"); return { disposition: "started" }; }
        return {};
      },
      respond(fields) { process.responses.push(fields); },
      async close() { process.closed = true; exit(new Error("closed")); },
    };
  };
  const runtime = new MultiagentRuntime(directory, record => records.push(record), async () => ({ cancelled: true }), factory, onMail); runtimes.push(runtime);
  return { directory, runtime, records, processes, factory };
}
function assistant(text: string, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 123 };
}
describe("multiagent runtime", () => {
  it("starts independent persistent background agents with original loadouts", async () => {
    const { runtime, records, processes } = await setup();
    const [a, b] = await Promise.all([runtime.start(agent, "one", process.cwd()), runtime.start(agent, "two", process.cwd())]);
    expect(a.id).not.toBe(b.id); expect(records).toHaveLength(2);
    expect(processes[0]!.args).toContain("--session"); expect(processes[0]!.args).not.toContain("--no-session");
    expect(processes[0]!.args).toContain("test/model"); expect(processes[0]!.args).toContain("read,multiagent_parent");
    expect(processes[0]!.args).toContain("--extension");
    expect(JSON.parse(await fs.readFile(a.sessionFile + ".config.json", "utf8")).systemPrompt).toBe("Original instructions");
    expect(a.status).toBe("running"); expect(b.status).toBe("running");
    const second = processes.find(p => p.args.includes(b.sessionFile))!;
    second.emit({ type: "message_end", message: assistant("two complete") });
    second.emit({ type: "agent_end" }); expect(b.status).toBe("running");
    second.emit({ type: "agent_settled" }); expect(b.status).toBe("idle"); expect(a.status).toBe("running");
    expect(lastAssistantText(b)).toBe("two complete");
    expect(childSessionCost(a)).toBeUndefined();
    b.messages.push({ ...assistant("usage"), usage: { cost: { total: 0.12 } } } as any);
    b.partial = { ...assistant("streaming"), usage: { cost: { total: 0.005 } } } as any;
    expect(childSessionCost(b)).toBeCloseTo(0.125);
  });
  it("steers, queues follow-ups, and clears queues before stopping one child", async () => {
    const { runtime, processes } = await setup();
    const a = await runtime.start(agent, "one", process.cwd());
    const b = await runtime.start(agent, "two", process.cwd());
    await runtime.send(a.id, "change direction"); await runtime.send(a.id, "then test", "followUp");
    expect(processes[0]!.calls.slice(-2)).toEqual([
      { type: "prompt", message: "change direction", streamingBehavior: "steer" },
      { type: "prompt", message: "then test", streamingBehavior: "followUp" },
    ]);
    await runtime.stop(a.id);
    expect(processes[0]!.calls.slice(-2).map(c => c.type)).toEqual(["clear_queue", "abort"]);
    expect(a.status).toBe("stopped"); expect(b.status).toBe("running"); expect(processes[1]!.closed).toBe(false);
    await runtime.send(a.id, "continue"); expect(a.status).toBe("running");
  });
  it("assembles deltas, replaces with finalized messages, and tracks live tools", async () => {
    const { runtime, processes } = await setup(); const child = await runtime.start(agent, "task", process.cwd()); const emit = processes[0]!.emit;
    emit({ type: "message_start", message: assistant("", "pending") });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
    expect(child.partial?.content[0]).toEqual({ type: "text", text: "partial" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final" } });
    expect(child.partial?.content[0]).toEqual({ type: "text", text: "final" });
    emit({ type: "message_end", message: assistant("authoritative") });
    expect(child.partial).toBeUndefined(); expect(lastAssistantText(child)).toBe("authoritative"); expect(child.messages).toHaveLength(1);
    emit({ type: "tool_execution_update", toolCallId: "call", partialResult: { content: [{ type: "text", text: "live output" }] } });
    expect(child.tools.get("call")?.isPartial).toBe(true);
    emit({ type: "message_end", message: { role: "toolResult", toolCallId: "call" } }); expect(child.tools.size).toBe(0);
  });
  it("restores child sessions lazily with their original settings, not changed definitions", async () => {
    const { runtime, records, processes, directory, factory } = await setup();
    const child = await runtime.start(agent, "one", process.cwd()); await fs.writeFile(child.sessionFile, "session fixture");
    await runtime.close(child.id);
    const restored = new MultiagentRuntime(directory, () => {}, async () => ({ cancelled: true }), factory); runtimes.push(restored);
    restored.restore(records); expect(restored.get(child.id).status).toBe("saved"); expect(processes).toHaveLength(1);
    await Promise.all([restored.connect(child.id), restored.connect(child.id)]); expect(processes).toHaveLength(2);
    expect(processes[1]!.args).toContain(child.sessionFile); expect(processes[1]!.args).toContain("test/model");
  });
  it("routes only explicit finalized child mail, with the transport's sender identity", async () => {
    const received: any[] = [];
    const { runtime, processes } = await setup((child, mail) => received.push({ childId: child.id, mail }));
    const child = await runtime.start(agent, "task", process.cwd());
    const mail = { id: "12345678-1234-1234-1234-123456789abc", kind: "question", text: "Need clarification" };
    const emit = processes[0]!.emit;
    emit({ type: "message_end", message: assistant("ordinary response") });
    emit({ type: "message_end", message: { role: "custom", customType: "other", details: mail } });
    emit({ type: "message_end", message: { role: "custom", customType: "wpi-multiagent-outgoing", details: {} } });
    expect(received).toEqual([]);
    emit({ type: "message_end", message: { role: "custom", customType: "wpi-multiagent-outgoing", details: mail } });
    expect(received).toEqual([{ childId: child.id, mail }]);
    await runtime.dispose();
    emit({ type: "message_end", message: { role: "custom", customType: "wpi-multiagent-outgoing", details: mail } });
    expect(received).toHaveLength(1);
  });

  it("denies unsupported interaction by default and correlates the child's UI ID", async () => {
    const { runtime, processes } = await setup(); await runtime.start(agent, "task", process.cwd());
    processes[0]!.emit({ type: "extension_ui_request", method: "confirm", id: "permission", title: "Allow?" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(processes[0]!.responses).toEqual([{ id: "permission", cancelled: true }]);
  });
  it("reports provider failure and unexpected exit, and releases all children on disposal", async () => {
    const { runtime, processes } = await setup(); const child = await runtime.start(agent, "task", process.cwd());
    processes[0]!.emit({ type: "message_end", message: { ...assistant("", "error"), errorMessage: "provider failure" } });
    processes[0]!.emit({ type: "agent_settled" }); expect(child.status).toBe("failed"); expect(child.error).toBe("provider failure");
    const second = await runtime.start(agent, "two", process.cwd()); processes[1]!.exit(new Error("unexpected exit"));
    expect(second.status).toBe("failed"); expect(second.transport).toBeUndefined();
    await runtime.dispose(); expect(processes[0]!.closed).toBe(true);
    await expect(runtime.start(agent, "later", process.cwd())).rejects.toThrow("closed");
  });
  it("does not leave a child running when initial prompt acceptance fails", async () => {
    const { runtime, factory } = await setup();
    const rejectFactory: TransportFactory = (...args) => {
      const transport = factory(...args);
      return { ...transport, request: async (type, fields) => { if (type === "prompt") throw new Error("bad prompt"); return transport.request(type, fields); } };
    };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multiagent-test-")); directories.push(directory);
    const rejected = new MultiagentRuntime(directory, () => {}, async () => ({ cancelled: true }), rejectFactory); runtimes.push(rejected);
    await expect(rejected.start(agent, "task", process.cwd())).rejects.toThrow("bad prompt");
    expect([...rejected.children.values()][0]!.transport).toBeUndefined();
    expect(runtime.children.size).toBe(0);
  });
});
