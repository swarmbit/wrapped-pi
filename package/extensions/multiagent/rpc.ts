import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";

/** Strict LF framing: Unicode separators and split UTF-8 characters are data. */
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(private receive: (record: any) => void) {}
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.receive(JSON.parse(line));
    }
    if (this.buffer.length > 32 * 1024 * 1024) throw new Error("RPC record exceeds 32 MiB");
  }
}

export function piInvocation(args: string[]) {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop()!))
    return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface Transport {
  request(type: string, fields?: Record<string, unknown>): Promise<any>;
  respond(fields: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** Own transport because RpcClient does not expose extension UI responses/exit events. */
export class RpcTransport implements Transport {
  private process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private failure?: Error;
  private stderr = "";
  private closing?: Promise<void>;
  private exited: Promise<void>;
  constructor(cwd: string, args: string[], onEvent: (event: any) => void, onExit: (error: Error) => void) {
    const invocation = piInvocation(["--mode", "rpc", ...args]);
    this.process = spawn(invocation.command, invocation.args, { cwd, stdio: "pipe", env: { ...process.env, WPI_MULTIAGENT_CHILD: "1" } });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      onExit(error);
    };
    const lines = new JsonLines(record => {
      if (record.type === "response") {
        const request = this.pending.get(record.id);
        if (!request) return;
        this.pending.delete(record.id); clearTimeout(request.timer);
        if (record.success) request.resolve(record.data);
        else request.reject(new Error(record.error || "RPC request failed"));
      } else {
        // A fault in a local event listener is not a protocol failure and must
        // not take the child down with it.
        try { onEvent(record); } catch { /* the child keeps running */ }
      }
    });
    this.process.stdout.on("data", chunk => {
      try { lines.push(chunk); } catch (error) { fail(error as Error); this.process.kill("SIGTERM"); }
    });
    this.process.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    this.process.stdin.on("error", fail);
    this.process.on("error", fail);
    this.exited = new Promise(resolve => {
      this.process.once("close", (code, signal) => {
        fail(new Error(`Pi child exited (${signal ?? code})${this.stderr ? `: ${this.stderr}` : ""}`));
        resolve();
      });
    });
  }
  request(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `multiagent-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`RPC ${type} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...fields, type, id });
    });
  }
  private write(record: Record<string, unknown>) {
    // Writable streams buffer records in order and handle pipe backpressure.
    this.process.stdin.write(JSON.stringify(record) + "\n", error => {
      if (!error) return;
      const request = this.pending.get(record.id as string);
      if (request) { clearTimeout(request.timer); request.reject(error); this.pending.delete(record.id as string); }
    });
  }
  respond(fields: Record<string, unknown>) {
    if (!this.failure) this.write({ ...fields, type: "extension_ui_response" });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.process.stdin.end();
      const term = setTimeout(() => this.process.kill("SIGTERM"), 1000);
      const kill = setTimeout(() => this.process.kill("SIGKILL"), 3000);
      try { await this.exited; } finally { clearTimeout(term); clearTimeout(kill); }
    })();
  }
}
