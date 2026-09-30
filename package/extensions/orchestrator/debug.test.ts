import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginDecisionDebug, decisionDebugPath, writeDecisionDebug } from "./debug";
import { runtimeFor } from "./runtime";
import { normalizeUsage } from "./usage";
import { SystemOneBackend } from "./decision";

let dir: string;
let ctx: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orchestrator-debug-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  ctx = { cwd: dir, sessionManager: { getSessionId: () => "source-session" }, ui: { notify: vi.fn() } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
const records = () => readFileSync(decisionDebugPath(dir), "utf8").trim().split("\n").map(line => JSON.parse(line));

describe("decision debug JSONL", () => {
  it("does no filesystem writes while disabled", () => {
    writeDecisionDebug(ctx, { event: "test" });
    const span = beginDecisionDebug(ctx, "routing", "request", "virtual", { request: "task" });
    expect(span.trace).toBeUndefined();
    span.finish({ decision: "stay" });
    expect(existsSync(join(dir, "agent"))).toBe(false);
  });
  it("correlates requests/responses and records honest end-to-end TPS estimates", () => {
    runtimeFor(dir).debugEnabled = true;
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(600);
    const span = beginDecisionDebug(ctx, "routing", "request", "virtual", { request: "task" });
    span.trace!({ phase: "response", endpoint: "http://localhost/decision", model: "classifier", httpStatus: 200,
      data: { answers: { route: { choice: "S0", probabilities: { S0: 0.9, NEW: 0.1 } } }, usage: { input_tokens: 100, output_tokens: 20 } } });
    span.finish({ effectiveDecision: { action: "reuse", realId: "source-session" } }, normalizeUsage({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }));
    span.finish({ ignored: true });
    const logged = records();
    expect(logged).toHaveLength(3);
    expect(new Set(logged.map(entry => entry.callId)).size).toBe(1);
    expect(logged[2]).toMatchObject({ requestId: "request", virtualId: "virtual", sessionId: "source-session", kind: "routing", status: "ok",
      metrics: { durationMs: 500, inputTokens: 100, outputTokens: 20, outputTokensPerSecond: 40, totalTokensPerSecond: 240, timeToFirstTokenMs: null } });
    expect(statSync(decisionDebugPath(dir)).mode & 0o777).toBe(0o600);
  });
  it("uses null rather than zero for unavailable token/TPS data", () => {
    runtimeFor(dir).debugEnabled = true;
    beginDecisionDebug(ctx, "handoff", "r", "v", {}).finish({ outcome: "confirmation_required" }, undefined, new Error("offline"));
    expect(records().at(-1)).toMatchObject({ status: "error", error: { message: "offline" }, metrics: { inputTokens: null, outputTokens: null, outputTokensPerSecond: null, totalTokensPerSecond: null } });
  });
  it("redacts known credentials in input, response, and errors before writing", () => {
    vi.stubEnv("TEST_DECISION_API_KEY", "test-private-credential-987654321");
    runtimeFor(dir).debugEnabled = true;
    const value = process.env.TEST_DECISION_API_KEY!;
    const span = beginDecisionDebug(ctx, "routing", "r", "v", { request: `Task ${value}` });
    span.trace!({ phase: "response", endpoint: "http://localhost", model: "m", data: { echoed: value } });
    span.finish({}, undefined, new Error(`Failed with ${value}`));
    expect(readFileSync(decisionDebugPath(dir), "utf8")).not.toContain(value);
    expect(records()).toHaveLength(3);
  });
  it("stops logging in-flight spans immediately when disabled", () => {
    runtimeFor(dir).debugEnabled = true;
    const span = beginDecisionDebug(ctx, "routing", "r", "v", {});
    runtimeFor(dir).debugEnabled = false;
    span.trace!({ phase: "response", endpoint: "http://localhost", model: "m" });
    span.finish({});
    expect(records()).toHaveLength(1);
  });
  it("rotates at 10 MiB while retaining private backups", () => {
    runtimeFor(dir).debugEnabled = true;
    writeDecisionDebug(ctx, { event: "old" });
    truncateSync(decisionDebugPath(dir), 10 * 1024 * 1024);
    writeDecisionDebug(ctx, { event: "new" });
    expect(records()[0].event).toBe("new");
    expect(existsSync(decisionDebugPath(dir) + ".1")).toBe(true);
    expect(statSync(decisionDebugPath(dir) + ".1").mode & 0o777).toBe(0o600);
  });
  it("bounds oversized entries without breaking JSONL", () => {
    runtimeFor(dir).debugEnabled = true;
    writeDecisionDebug(ctx, { event: "large", callId: "call", response: "x".repeat(200_000) });
    expect(records()[0]).toMatchObject({ event: "truncated_record", callId: "call" });
    expect(statSync(decisionDebugPath(dir)).size).toBeLessThan(128 * 1024);
  });
  it.each(["directory", "symlink", "hardlink"])("fails safely on a %s log target", kind => {
    runtimeFor(dir).debugEnabled = true;
    const file = decisionDebugPath(dir);
    mkdirSync(join(dir, "agent", "orchestrator"), { recursive: true });
    const other = join(dir, "other");
    writeFileSync(other, "unchanged");
    if (kind === "directory") mkdirSync(file);
    if (kind === "symlink") symlinkSync(other, file);
    if (kind === "hardlink") linkSync(other, file);
    expect(() => writeDecisionDebug(ctx, { event: "test" })).not.toThrow();
    writeDecisionDebug(ctx, { event: "test2" });
    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(readFileSync(other, "utf8")).toBe("unchanged");
  });
  it("captures System One wire payloads without authentication headers or URL queries", async () => {
    runtimeFor(dir).debugEnabled = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { handoff: { choice: "NOT_NEEDED", probabilities: { NEEDED: 0.1, NOT_NEEDED: 0.9 } } }, usage: { input_tokens: 22, output_tokens: 0 } }))));
    const span = beginDecisionDebug(ctx, "handoff", "r", "v", {});
    const result = await new SystemOneBackend("http://localhost/decision?private=hidden", "classifier", "private-auth-value").evaluateHandoff(
      { request: "task", sourceSummary: "source", destinationSummary: "destination", switchReason: "switch" }, undefined, span.trace);
    span.finish({ result }, result.usage);
    const logged = records();
    expect(logged.find(entry => entry.event === "http_request")).toMatchObject({ endpoint: "http://localhost/decision", model: "classifier", data: { questions: { handoff: { type: "choice" } } } });
    expect(logged.find(entry => entry.event === "http_response").data.answers.handoff.choice).toBe("NOT_NEEDED");
    const text = readFileSync(decisionDebugPath(dir), "utf8");
    expect(text).not.toContain("private-auth-value");
    expect(text).not.toContain("private=hidden");
  });
  it("captures HTTP error responses and still rejects the decision", async () => {
    runtimeFor(dir).debugEnabled = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("server unavailable", { status: 503 })));
    const span = beginDecisionDebug(ctx, "routing", "r", "v", {});
    try { await new SystemOneBackend("http://localhost", "m").evaluate("task", [], undefined, span.trace); }
    catch (error) { span.finish({ outcome: "fallback" }, undefined, error); }
    expect(records().find(entry => entry.event === "http_response")).toMatchObject({ httpStatus: 503, data: { rawBody: "server unavailable" } });
    expect(records().at(-1).status).toBe("error");
  });
});
