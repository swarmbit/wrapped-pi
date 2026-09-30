import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const directory = resolve("package/tools/orchestrator-debug-viewer");
const sandbox: any = {};
runInContext(readFileSync(resolve(directory, "logs.js"), "utf8"), createContext(sandbox));
const logs = sandbox.OrchestratorDebugLogs;
const row = (event: string, fields: any = {}) => ({ schemaVersion: 1, timestamp: "2026-01-01T10:00:00.000Z", event, ...fields });
const jsonl = (records: any[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

function fixture() {
  return [
    row("debug_enabled"),
    row("decision_start", { callId: "routing", requestId: "request", kind: "routing", sessionId: "source", virtualId: "virtual", input: { text: "Continue OAuth" } }),
    row("http_request", { callId: "routing", requestId: "request", kind: "routing", model: "classifier", data: { state: { request: "Continue OAuth" } } }),
    row("http_response", { callId: "routing", requestId: "request", kind: "routing", httpStatus: 200, data: { answers: { route: { choice: "S1" } } } }),
    row("decision_end", { callId: "routing", requestId: "request", kind: "routing", status: "ok", outcome: "selected", effectiveDecision: { action: "reuse", realId: "target" }, metrics: { durationMs: 200, inputTokens: 100, outputTokens: 0, outputTokensPerSecond: 0, totalTokensPerSecond: 500 } }),
    row("decision_start", { callId: "handoff", requestId: "request", kind: "handoff", timestamp: "2026-01-01T10:00:01.000Z", input: { request: "Continue OAuth", sourceSummary: "PKCE" } }),
    row("decision_end", { callId: "handoff", requestId: "request", kind: "handoff", status: "error", outcome: "confirmation_required", error: { message: "offline" }, metrics: { durationMs: 500, inputTokens: null, outputTokens: null } }),
    row("handoff_confirmation", { requestId: "request", choice: "Cancel switch" }),
    row("decision_start", { callId: "unfinished", requestId: "other", kind: "routing", timestamp: "2026-01-01T10:00:02.000Z", input: { text: "Partial call" } }),
  ];
}

describe("standalone orchestrator log viewer", () => {
  it("parses JSONL snapshots, deduplicates overlaps, and skips malformed trailing lines", () => {
    const data = fixture();
    const result = logs.parse([{ name: "current.jsonl", text: jsonl(data) + '{"incomplete":' }, { name: "backup.1", text: jsonl(data.slice(0, 2)) + "null\n[]\n" }]);
    expect(result.records).toHaveLength(data.length);
    expect(result.duplicates).toBe(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.records[0].sourceFile).toBe("current.jsonl");
    expect(result.records[0].sourceLine).toBe(1);
  });
  it("groups by call ID and correlates routing, handoff, and dispatch events", () => {
    const calls = logs.group(logs.parse([{ name: "log", text: jsonl(fixture()) }]).records);
    expect(calls.map((call: any) => call.id)).toEqual(["unfinished", "handoff", "routing"]);
    expect(calls[2]).toMatchObject({ request: "Continue OAuth", kind: "routing", model: "classifier", status: "ok", duration: 200, inputTokens: 100, outputTokens: 0, outputTps: 0 });
    expect(calls[1]).toMatchObject({ status: "error", inputTokens: null, outputTokens: null });
    expect(calls[0]).toMatchObject({ status: "incomplete", duration: null });
    expect(calls[2].requestEvents[0].event).toBe("handoff_confirmation");
  });
  it("filters by text, decision kind, and status", () => {
    const calls = logs.group(logs.parse([{ name: "log", text: jsonl(fixture()) }]).records);
    expect(logs.filter(calls, "oauth", "", "")).toHaveLength(2);
    expect(logs.filter(calls, "OFFLINE", "handoff", "error")).toHaveLength(1);
    expect(logs.filter(calls, "", "routing", "incomplete")).toHaveLength(1);
    expect(logs.filter(calls, "not present", "", "")).toHaveLength(0);
  });
  it("keeps unknown totals partial instead of treating them as zero", () => {
    const calls = logs.group(logs.parse([{ name: "log", text: jsonl(fixture()) }]).records);
    expect(logs.stats(calls)).toMatchObject({ calls: 3, errors: 1, incomplete: 1, medianDuration: 350,
      inputTokens: { value: 100, known: 1, total: 3 }, outputTokens: { value: 0, known: 1, total: 3 } });
    expect(logs.stats([calls[0]]).inputTokens.value).toBeNull();
  });
  it("handles truncated and partial logs without fabricating metrics", () => {
    const data = [row("truncated_record", { callId: "partial", requestId: "r", redactedPreview: "partial" })];
    expect(logs.group(logs.parse([{ name: "log", text: jsonl(data) }]).records)[0]).toMatchObject({ truncated: true, status: "incomplete", outcome: "truncated", duration: null, model: "Not reported" });
  });
  it("tolerates malformed field types and oversized records", () => {
    const data = [row("decision_end", { callId: "weird", kind: {}, timestamp: { toString: "bad" }, outcome: [], metrics: { durationMs: -1, outputTokens: "10" }, status: "ok" })];
    const parsed = logs.parse([{ name: "log", text: jsonl(data) + JSON.stringify(row("oversized", { content: "x".repeat(600_000) })) }]);
    expect(parsed.warnings).toHaveLength(1);
    expect(logs.group(parsed.records)[0]).toMatchObject({ kind: "unknown", timestamp: "Unknown time", duration: null, outputTokens: null });
  });
  it("preserves hostile text as data, never rendering it as HTML or making network calls", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    const call = logs.group(logs.parse([{ name: "log", text: jsonl([row("decision_start", { callId: "hostile", input: { text: hostile } })]) }]).records)[0];
    expect(call.request).toBe(hostile);
    const viewer = readFileSync(resolve(directory, "viewer.js"), "utf8");
    expect(viewer).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\bfetch\s*\(|XMLHttpRequest|\beval\s*\(/);
    const html = readFileSync(resolve(directory, "index.html"), "utf8");
    expect(html).toContain("connect-src 'none'");
    for (const asset of ["logs.js", "viewer.js", "style.css"]) expect(existsSync(resolve(directory, asset))).toBe(true);
  });
});
