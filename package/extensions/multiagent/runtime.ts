import type { RpcClient } from "@earendil-works/pi-coding-agent";
export type AgentMessage = Awaited<ReturnType<RpcClient["getMessages"]>>[number];
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
import type { AgentConfig } from "../subagent/agents.js";
import { RpcTransport, type Transport } from "./rpc.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { OUTGOING_MAIL, validOutgoing, type OutgoingMail } from "./mailbox.js";

export interface ChildRecord { id: string; agent: string; cwd: string; sessionFile: string; model?: string }
export type ChildStatus = "saved" | "starting" | "running" | "idle" | "stopped" | "failed" | "closed";
export interface Child extends ChildRecord {
  status: ChildStatus;
  messages: AgentMessage[];
  partial?: AssistantMessage;
  transport?: Transport;
  error?: string;
  queue: { steering: string[]; followUp: string[] };
  tools: Map<string, { result?: any; isPartial: boolean }>;
}
export type TransportFactory = (cwd: string, args: string[], event: (event: any) => void, exit: (error: Error) => void) => Transport;
export type DialogHandler = (child: Child, request: any) => Promise<Record<string, unknown>>;

export class MultiagentRuntime {
  readonly children = new Map<string, Child>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private stopped = new Set<string>();
  private boots = new Map<string, Promise<Child>>();
  constructor(private directory: string, private persist: (record: ChildRecord) => void,
    private dialog: DialogHandler, private factory: TransportFactory = (cwd, args, event, exit) => new RpcTransport(cwd, args, event, exit),
    private onMail?: (child: Child, mail: OutgoingMail) => void) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  restore(records: ChildRecord[]) {
    for (const record of records) if (!this.children.has(record.id))
      this.children.set(record.id, { ...record, status: "saved", messages: [], tools: new Map(), queue: { steering: [], followUp: [] } });
  }
  get(id: string) { const child = this.children.get(id); if (!child) throw new Error(`Unknown multiagent: ${id}`); return child; }
  async start(agent: AgentConfig, task: string, cwd: string) {
    if (!task.trim()) throw new Error("A task is required");
    if (this.disposed) throw new Error("Multiagent runtime is closed");
    if ([...this.children.values()].filter(c => c.transport || c.status === "starting").length >= 8)
      throw new Error("At most 8 live agents; close an idle agent first");
    const id = randomUUID().slice(0, 8);
    const child: Child = { id, agent: agent.name, cwd, sessionFile: path.join(this.directory, `${id}.jsonl`), model: agent.model,
      status: "starting", messages: [], tools: new Map(), queue: { steering: [], followUp: [] } };
    this.children.set(id, child); this.changed();
    try {
      const boot = this.boot(child, agent);
      this.boots.set(id, boot);
      try { await boot; } finally { this.boots.delete(id); }
      this.persist({ id, agent: agent.name, cwd, sessionFile: child.sessionFile, model: agent.model });
      await this.send(id, task);
      return child;
    } catch (error) {
      child.status = "failed"; child.error = (error as Error).message;
      await child.transport?.close(); child.transport = undefined; this.changed(); throw error;
    }
  }
  async connect(id: string) {
    const child = this.get(id);
    if (this.boots.has(id)) return this.boots.get(id)!;
    if (child.transport) return child;
    if (!this.boots.has(id)) this.boots.set(id, (async () => {
      await fs.access(child.sessionFile);
      return await this.boot(child);
    })().catch(error => {
      child.status = "failed"; child.error = (error as Error).message; this.changed(); throw error;
    }).finally(() => this.boots.delete(id)));
    return this.boots.get(id)!;
  }
  private async boot(child: Child, agent?: AgentConfig) {
    if (this.disposed) throw new Error("Multiagent runtime is closed");
    if (!agent && [...this.children.values()].filter(c => c !== child && (c.transport || c.status === "starting")).length >= 8)
      throw new Error("At most 8 live agents");
    child.status = "starting"; child.error = undefined; this.changed();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const configFile = child.sessionFile + ".config.json";
    if (agent) await fs.writeFile(configFile, JSON.stringify({ model: agent.model, tools: agent.tools, systemPrompt: agent.systemPrompt }), { mode: 0o600 });
    else agent = JSON.parse(await fs.readFile(configFile, "utf8")) as AgentConfig;
    child.model = agent.model;
    const args = ["--session", child.sessionFile, "--name", `multiagent ${child.agent} ${child.id}`,
      "--extension", path.join(__dirname, "index.ts")];
    let promptFile: string | undefined;
    if (agent?.model) args.push("--model", agent.model);
    if (agent?.tools?.length) args.push("--tools", [...new Set([...agent.tools, "multiagent_parent"])].join(","));
    if (agent?.systemPrompt?.trim()) {
      promptFile = path.join(this.directory, `${child.id}.prompt.txt`);
      await fs.writeFile(promptFile, agent.systemPrompt, { mode: 0o600 });
      args.push("--append-system-prompt", promptFile);
    }
    if (this.disposed) { if (promptFile) await fs.rm(promptFile, { force: true }); throw new Error("Multiagent runtime is closed"); }
    const transport = this.factory(child.cwd, args, event => this.event(child, event), error => {
      child.transport = undefined;
      if (child.status !== "closed") { child.status = "failed"; child.error = error.message; }
      this.changed();
    });
    child.transport = transport;
    try {
      await transport.request("get_state");
      child.messages = (await transport.request("get_messages")).messages;
      for (const message of child.messages) this.receiveMail(child, message);
      child.partial = undefined; child.tools.clear();
      child.status = "idle"; this.changed(); return child;
    } catch (error) {
      child.status = "failed"; child.error = (error as Error).message;
      await transport.close(); child.transport = undefined; this.changed(); throw error;
    } finally { if (promptFile) await fs.rm(promptFile, { force: true }); }
  }
  async send(id: string, message: string, mode: "steer" | "followUp" = "steer") {
    if (!message.trim()) throw new Error("A message is required");
    const child = await this.connect(id);
    if (child.status === "starting") throw new Error("Agent is still starting");
    const previous = child.status;
    this.stopped.delete(id); child.status = "running"; this.changed();
    try {
      const result = await child.transport!.request("prompt", { message, streamingBehavior: mode });
      if (result?.disposition === "handled" && child.status === "running") child.status = previous;
    } catch (error) { child.status = previous; this.changed(); throw error; }
    this.changed();
  }
  async stop(id: string) {
    const child = this.get(id);
    if (!child.transport) return;
    this.stopped.add(id);
    // Abort alone can start queued work; clear it first.
    try {
      await child.transport.request("clear_queue");
      await child.transport.request("abort");
      child.queue = { steering: [], followUp: [] };
      child.status = "stopped";
    } catch (error) {
      // A wedged child must not leave the user's stop request ineffective.
      child.status = "closed"; await child.transport?.close(); child.transport = undefined;
      throw error;
    } finally { this.changed(); }
  }
  async close(id: string) {
    const child = this.get(id); child.status = "closed";
    await child.transport?.close(); child.transport = undefined; this.changed();
  }
  async dispose() {
    this.disposed = true;
    await Promise.all([...this.children.keys()].map(id => this.close(id)));
    this.listeners.clear();
  }
  private receiveMail(child: Child, message: any) {
    if (!this.disposed && message?.role === "custom" && message.customType === OUTGOING_MAIL && validOutgoing(message.details))
      this.onMail?.(child, message.details);
  }
  private event(child: Child, event: any) {
    if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        void this.dialog(child, event).catch(() => ({ cancelled: true })).then(response =>
          child.transport?.respond({ ...response, id: event.id }));
      }
      return;
    }
    if (event.type === "agent_start") child.status = "running";
    if (event.type === "agent_settled") {
      const last = [...child.messages].reverse().find(m => m.role === "assistant") as AssistantMessage | undefined;
      child.status = this.stopped.has(child.id) || last?.stopReason === "aborted" ? "stopped" : last?.stopReason === "error" ? "failed" : "idle";
      child.error = last?.errorMessage;
    }
    if (event.type === "queue_update") child.queue = { steering: event.steering, followUp: event.followUp };
    if (event.type === "message_start" && event.message.role === "assistant") child.partial = structuredClone(event.message);
    if (event.type === "message_update" && child.partial) {
      const update = event.assistantMessageEvent;
      const index = update.contentIndex;
      if (Number.isInteger(index) && (update.type.startsWith("text_") || update.type.startsWith("thinking_"))) {
        const thinking = update.type.startsWith("thinking_");
        const field = thinking ? "thinking" : "text";
        const block = child.partial.content[index] as any;
        const next = block ?? { type: thinking ? "thinking" : "text", [field]: "" };
        if (update.type.endsWith("_delta")) next[field] += update.delta;
        if (update.type.endsWith("_end")) next[field] = update.content;
        child.partial.content[index] = next;
      }
      if (update.type === "toolcall_end") child.partial.content[index] = update.toolCall;
      if (event.usage) child.partial.usage = event.usage;
    }
    if (event.type === "tool_execution_start") child.tools.set(event.toolCallId, { isPartial: true });
    if (event.type === "tool_execution_update") child.tools.set(event.toolCallId, { result: event.partialResult, isPartial: true });
    if (event.type === "tool_execution_end") child.tools.set(event.toolCallId, { result: { ...event.result, isError: event.isError }, isPartial: false });
    if (event.type === "message_end") {
      this.receiveMail(child, event.message);
      if (event.message.role === "toolResult") child.tools.delete(event.message.toolCallId);
      child.messages.push(event.message);
      if (event.message.role === "assistant") child.partial = undefined;
    }
    this.changed();
  }
}

export function childSessionCost(child: Child): number | undefined {
  let total = 0;
  let known = false;
  for (const message of [...child.messages, ...(child.partial ? [child.partial] : [])]) {
    if (message.role !== "assistant") continue;
    const cost = (message as AssistantMessage & { usage?: { cost?: { total?: number } } }).usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) { total += cost; known = true; }
  }
  return known ? total : undefined;
}

export function lastAssistantText(child: Child) {
  const message = [...child.messages].reverse().find(m => m.role === "assistant") as AssistantMessage | undefined;
  return message?.content.filter(p => p.type === "text").map(p => p.text).join("\n") ?? "";
}
