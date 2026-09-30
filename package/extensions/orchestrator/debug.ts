import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionTrace, DecisionTraceEvent } from "./decision";
import type { TokenUsage } from "./types";
import { canonicalWorkspace, registryPath } from "./store";
import { runtimeFor } from "./runtime";
import { redactForLlm } from "../secret-redaction/state";

export function decisionDebugPath(cwd: string): string {
  return registryPath(cwd).replace(/\.json$/, ".decisions.jsonl");
}

function appendPrivate(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd = openSync(file, flags, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe decision debug file.");
    fchmodSync(fd, 0o600);
    if (stat.size + Buffer.byteLength(line) > 10 * 1024 * 1024) {
      closeSync(fd);
      fd = -1;
      for (let index = 2; index >= 0; index--) {
        try { renameSync(index === 0 ? file : `${file}.${index}`, `${file}.${index + 1}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      fd = openSync(file, flags, 0o600);
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) throw new Error("Unsafe decision debug file.");
      fchmodSync(fd, 0o600);
    }
    appendFileSync(fd, line, "utf8");
  } finally { if (fd !== -1) closeSync(fd); }
}

/** Logging is optional and must never change admission, routing, or delivery. */
export function writeDecisionDebug(ctx: ExtensionContext, event: Record<string, unknown>): void {
  const state = runtimeFor(canonicalWorkspace(ctx.cwd));
  if (!state.debugEnabled) return;
  try {
    const record = redactForLlm({ schemaVersion: 1, timestamp: new Date().toISOString(), pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(), ...event }, ctx);
    const serialized = JSON.stringify(record);
    const bytes = Buffer.byteLength(serialized);
    const line = bytes <= 128 * 1024 ? serialized : JSON.stringify({
      schemaVersion: 1, timestamp: new Date().toISOString(), event: "truncated_record",
      callId: (record as Record<string, unknown>).callId, requestId: (record as Record<string, unknown>).requestId,
      kind: (record as Record<string, unknown>).kind, originalBytes: bytes,
      // Redact BEFORE truncation so an incomplete credential cannot evade masking.
      redactedPreview: Buffer.from(serialized).subarray(0, 32 * 1024).toString("utf8"),
    });
    appendPrivate(decisionDebugPath(ctx.cwd), line + "\n");
  } catch {
    if (!state.debugWarningShown) {
      state.debugWarningShown = true;
      try { ctx.ui.notify("Could not write orchestrator decision debug log. Decisions will continue normally.", "warning"); }
      catch { /* runtime replaced */ }
    }
  }
}

export interface DecisionDebugSpan {
  trace?: DecisionTrace;
  finish(data: Record<string, unknown>, usage?: TokenUsage, error?: unknown): void;
}

export function beginDecisionDebug(ctx: ExtensionContext, kind: "routing" | "handoff" | "model",
  requestId: string, virtualId: string, input: unknown): DecisionDebugSpan {
  if (!runtimeFor(canonicalWorkspace(ctx.cwd)).debugEnabled) return { finish() {} };
  const callId = randomUUID();
  const base = { callId, requestId, virtualId, kind };
  const started = performance.now();
  let finished = false;
  let reportedUsage: { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  writeDecisionDebug(ctx, { ...base, event: "decision_start", input });
  return {
    trace: (event: DecisionTraceEvent) => {
      if (event.phase === "response" && event.data && typeof event.data === "object") {
        reportedUsage = (event.data as { usage?: typeof reportedUsage }).usage;
      }
      writeDecisionDebug(ctx, { ...base, event: `http_${event.phase}`, ...event });
    },
    finish(data, usage, error) {
      if (finished) return;
      finished = true;
      const durationMs = Math.max(0, performance.now() - started);
      const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      const inputTokens = finite(reportedUsage?.input_tokens ?? (usage?.incompleteTokens === false ? usage.input : null));
      const outputTokens = finite(reportedUsage?.output_tokens ?? (usage?.incompleteTokens === false ? usage.output : null));
      const rate = (value: number | null) => value !== null && durationMs > 0 ? value * 1000 / durationMs : null;
      writeDecisionDebug(ctx, { ...base, event: "decision_end", ...data,
        status: error ? "error" : "ok", error: error ? { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } : undefined,
        metrics: { durationMs, inputTokens, outputTokens,
          outputTokensPerSecond: rate(outputTokens),
          totalTokensPerSecond: rate(inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
          throughputBasis: "end-to-end estimate including network latency; not generation TPS", timeToFirstTokenMs: null,
        }, usage: usage ?? null,
      });
    },
  };
}
