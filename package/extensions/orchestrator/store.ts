import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { MemberSession, Registry, UsageEvent, VirtualSession } from "./types";

export function canonicalWorkspace(cwd: string): string {
  return realpathSync(resolve(cwd));
}

export function registryPath(cwd: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const key = createHash("sha256").update(canonicalWorkspace(cwd)).digest("hex");
  return join(agentDir, "orchestrator", `${key}.json`);
}

export class RegistryStore {
  constructor(readonly file: string, readonly workspace: string) {}

  read(): Registry {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, workspace: this.workspace, virtualSessions: [], members: [], usage: [], requests: [] };
    }
    const data = JSON.parse(text) as Registry;
    if (data.version !== 1 || data.workspace !== this.workspace ||
        ![data.virtualSessions, data.members, data.usage, data.requests].every(Array.isArray)) {
      throw new Error("Invalid orchestrator registry; restore it from backup rather than overwriting it.");
    }
    return data;
  }

  /** Fail fast on contention. Never overwrite another process's registry. */
  update<T>(change: (data: Registry) => T): T {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Orchestrator registry is locked: ${lock}. Check for another Pi process before removing a stale lock.`);
      }
      throw error;
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const data = this.read();
      const result = change(data);
      writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, this.file);
      return result;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
      try { unlinkSync(temporary); } catch { /* no temp file after successful rename */ }
    }
  }

  create(name: string): VirtualSession {
    return this.update(data => {
      const clean = validateName(name);
      if (data.virtualSessions.some(session => session.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        throw new Error(`An orchestrator named "${clean}" already exists.`);
      }
      const session = { id: randomUUID(), name: clean, createdAt: new Date().toISOString() };
      data.virtualSessions.push(session);
      data.lastSelectedVirtualId = session.id;
      return session;
    });
  }

  find(nameOrId: string): VirtualSession {
    const query = nameOrId.trim().toLocaleLowerCase();
    const match = this.read().virtualSessions.find(session => session.id === nameOrId || session.name.toLocaleLowerCase() === query);
    if (!match) throw new Error(`No orchestrator named "${nameOrId}" in this workspace.`);
    return match;
  }

  rename(id: string, name: string): void {
    this.update(data => {
      const clean = validateName(name);
      if (data.virtualSessions.some(session => session.id !== id && session.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        throw new Error(`An orchestrator named "${clean}" already exists.`);
      }
      const session = data.virtualSessions.find(session => session.id === id);
      if (!session) throw new Error("Orchestrator no longer exists.");
      session.name = clean;
    });
  }

  attach(member: MemberSession, baseline: UsageEvent[]): void {
    this.update(data => {
      if (!data.virtualSessions.some(session => session.id === member.virtualId)) throw new Error("Unknown orchestrator.");
      const existing = data.members.find(item => item.id === member.id);
      if (existing) throw new Error("Real session already belongs to an orchestrator.");
      member.baselineSources = baseline.map(event => event.source);
      data.members.push(member);
      for (const event of baseline) addUsage(data, event);
      data.virtualSessions.find(session => session.id === member.virtualId)!.lastRealSessionId = member.id;
    });
  }

  reconcile(realId: string, events: UsageEvent[], context?: { name: string; summary: string }): void {
    this.update(data => {
      const member = data.members.find(item => item.id === realId);
      if (!member) return;
      for (const event of events) {
        const belongs = !member.baselineSources.includes(event.source);
        addUsage(data, { ...event, virtualId: belongs ? member.virtualId : undefined });
      }
      if (context) {
        member.name = context.name;
        member.summary = context.summary;
        member.lastActivityAt = new Date().toISOString();
      }
    });
  }

  record(event: UsageEvent): void { this.update(data => addUsage(data, event)); }

  /** Exclusive, process-independent lease held through the worker run. */
  lease(): () => void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const file = `${this.file}.execution`;
    let fd: number;
    try { fd = openSync(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Another orchestrator run owns ${file}. Verify its process has stopped before removing a stale lease.`);
      }
      throw error;
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
    let released = false;
    return () => { if (!released) { released = true; unlinkSync(file); } };
  }
}

function addUsage(data: Registry, event: UsageEvent): void {
  if (!data.usage.some(item => item.source === event.source)) data.usage.push(event);
}

export function validateName(name: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 100 || /[\x00-\x1f\x7f]/.test(clean)) {
    throw new Error("Use a nonempty name of at most 100 characters without control characters.");
  }
  return clean;
}
