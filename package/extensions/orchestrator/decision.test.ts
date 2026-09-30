import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemOneBackend, permitsSessionChange, shortlist, type RoutingCandidate } from "./decision";
import { normalizeUsage } from "./usage";
import type { MemberSession } from "./types";
const members: MemberSession[] = [
  { id: "auth", virtualId: "v", file: "a", name: "OAuth", goal: "Implement OAuth callback", summary: "PKCE tests", lastActivityAt: "2026-01-01", origin: "created", baselineSources: [] },
  { id: "docker", virtualId: "v", file: "b", name: "Docker", goal: "Docker networking", summary: "Ports", lastActivityAt: "2026-01-02", origin: "created", baselineSources: [] },
];
afterEach(() => vi.unstubAllGlobals());
function response(choice: string, probabilities: Record<string, number>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { route: { choice, probabilities } }, usage: { input_tokens: 42, output_tokens: 0 } }))));
}

describe("handoff decision adapter", () => {
  const input = { request: "Continue that", sourceSummary: "PKCE selected", destinationSummary: "OAuth", switchReason: "Required prior context", preservationNotes: "Keep pending tests" };
  it.each(["NEEDED", "NOT_NEEDED"])("accepts a strong %s handoff decision", async choice => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { handoff: { choice, probabilities: { NEEDED: choice === "NEEDED" ? 0.9 : 0.1, NOT_NEEDED: choice === "NOT_NEEDED" ? 0.9 : 0.1 } } }, usage: { input_tokens: 15, output_tokens: 0 } }))));
    const result = await new SystemOneBackend("http://localhost", "decision-model").evaluateHandoff(input);
    expect(result.needed).toBe(choice === "NEEDED");
    expect(result.usage?.input).toBe(15);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.model).toBe("decision-model");
    expect(body.state).toEqual(input);
    expect(body.questions.handoff.type).toBe("choice");
  });
  it.each([
    { choice: "NEEDED", probabilities: { NEEDED: 0.6, NOT_NEEDED: 0.4 } },
    { choice: "NOT_NEEDED", probabilities: { NEEDED: 0.9, NOT_NEEDED: 0.1 } },
    { choice: "NEEDED", probabilities: { NEEDED: 0.9, NOT_NEEDED: 0.1, EXTRA: 0 } },
    { choice: "NEEDED", probabilities: { NEEDED: 0.9 } },
  ])("fails closed on malformed or ambiguous decisions", async answer => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { handoff: answer } }))));
    await expect(new SystemOneBackend("http://localhost", "m").evaluateHandoff(input)).rejects.toThrow();
  });
});

describe("decision adapter", () => {
  it("selects an allowlisted continuation and keeps classification costs unknown", async () => {
    response("S0", { NEW: 0.02, S0: 0.95, S1: 0.03 });
    const result = await new SystemOneBackend("http://localhost:8000/v1/systemone", "multilingual").evaluate("Add tests", members);
    expect(result.decision).toMatchObject({ action: "reuse", realId: "auth" });
    expect(result.usage?.input).toBe(42);
    expect(result.usage?.incompleteCost).toBe(true);
    const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(request.questions.route.type).toBe("choice");
    expect(request.model).toBe("multilingual");
    expect(request.state.sessions).toHaveLength(2);
    expect(request.state.sessions[0].summary).toBe("PKCE tests");
    expect(request.questions.route.criteria.S0).not.toContain("Implement OAuth callback");
  });
  it("sends usage and context metrics with continuity-first routing instructions", async () => {
    response("S0", { NEW: 0.02, S0: 0.95, S1: 0.03 });
    const candidates: RoutingCandidate[] = members.map((member, index) => ({
      ...member,
      metrics: {
        lifetimeUsage: normalizeUsage(index === 0
          ? { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100, cost: { total: 0.25 } }
          : undefined),
        context: { tokens: index === 0 ? 6600 : null, contextWindow: null, estimated: true },
      },
    }));
    await new SystemOneBackend("http://localhost", "m").evaluate("Add tests", candidates);
    const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(request.state.sessions[0].metrics).toEqual(candidates[0].metrics);
    expect(request.state.sessions[1].metrics.lifetimeUsage.incompleteCost).toBe(true);
    expect(request.state.sessions[1].metrics.context.tokens).toBeNull();
    expect(request.questions.route.instructions).toContain("Prioritize required task context over savings");
    expect(request.questions.route.instructions).toContain("not the price of the next request");
  });
  it.each([0.8, 0.85, 0.99])("automatically selects required context only at a strong score (score %s)", async score => {
    response("S0", { NEW: 1 - score, S0: score, S1: 0 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("Follow up", members)).decision)
      .toMatchObject({ action: "reuse", realId: "auth" });
  });
  it.each([0.5, 0.6, 0.75, 0.7999])("rejects switching on insufficient scores (score %s)", async score => {
    response("S0", { NEW: (1 - score) / 2, S0: score, S1: (1 - score) / 2 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("Follow up", members)).decision.action)
      .toBe("clarify");
  });
  it("rejects independent work at the previous permissive threshold", async () => {
    response("NEW", { NEW: 0.61, S0: 0.39, S1: 0 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("New task", members)).decision.action).toBe("clarify");
  });
  it("selects independent work at the 80% boundary", async () => {
    response("NEW", { NEW: 0.8, S0: 0.2, S1: 0 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("New task", members)).decision.action).toBe("new");
  });
  it.each([0.61, 0.7, 0.79, 0.7999])("retains the current session when NEW scores %s", async score => {
    response("NEW", { NEW: score, S0: 1 - score, S1: 0 });
    const candidates = members.map(member => ({ ...member, isCurrent: member.id === "auth" }));
    const result = await new SystemOneBackend("http://localhost", "m").evaluate("Different topic", candidates);
    expect(result.decision).toMatchObject({ action: "reuse", realId: "auth" });
    const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(request.state.sessions[0].isCurrent).toBe(true);
    expect(request.state.sessions[1].isCurrent).toBe(false);
    expect(request.questions.route.instructions).toContain("Topic drift or a different keyword does not require isolation");
    expect(request.questions.route.instructions).toContain("never justify changing sessions");
  });
  it("retains the current session on a moderately confident alternative and ambiguous follow-ups", async () => {
    const candidates = members.map(member => ({ ...member, isCurrent: member.id === "auth" }));
    response("S1", { NEW: 0.01, S0: 0.2, S1: 0.79 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("Add tests for that", candidates)).decision)
      .toMatchObject({ action: "reuse", realId: "auth" });
    response("S0", { NEW: 0.3, S0: 0.4, S1: 0.3 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("Fix it", candidates)).decision)
      .toMatchObject({ action: "reuse", realId: "auth" });
  });
  it("allows another member only at a strong score and wide margin", async () => {
    response("S1", { NEW: 0.01, S0: 0.01, S1: 0.98 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("Resume Docker networking", members.map(member => ({ ...member, isCurrent: member.id === "auth" })))).decision)
      .toMatchObject({ action: "reuse", realId: "docker", confidence: 0.98, margin: 0.97 });
  });
  it("requires valid confidence and margin evidence from any backend", () => {
    expect(permitsSessionChange({ action: "new", reason: "different" })).toBe(false);
    expect(permitsSessionChange({ action: "new", reason: "different", confidence: 0.8, margin: 0.59 })).toBe(false);
    expect(permitsSessionChange({ action: "reuse", reason: "context", confidence: 0.99, margin: 0.59 })).toBe(false);
    expect(permitsSessionChange({ action: "reuse", reason: "context", confidence: 0.8, margin: 0.6 })).toBe(true);
    expect(permitsSessionChange({ action: "new", reason: "isolated", confidence: 0.8, margin: 0.6 })).toBe(true);
    for (const confidence of [NaN, Infinity, 1.1, -1]) {
      expect(permitsSessionChange({ action: "new", reason: "invalid", confidence, margin: 0.99 })).toBe(false);
    }
  });
  it("clarifies uncertain decisions instead of treating confidence as calibration", async () => {
    response("S0", { NEW: 0.3, S0: 0.4, S1: 0.3 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("that", members)).decision.action).toBe("clarify");
  });
  it("rejects unknown candidates and inconsistent probabilities", async () => {
    response("SECRET", { SECRET: 1 });
    await expect(new SystemOneBackend("http://localhost", "m").evaluate("task", members)).rejects.toThrow("unknown candidate");
    response("S0", { NEW: 0.8, S0: 0.1, S1: 0.1 });
    await expect(new SystemOneBackend("http://localhost", "m").evaluate("task", members)).rejects.toThrow("disagrees");
  });
  it("rejects bad numbers, HTTP failures, and over-budget input", async () => {
    response("S0", { NEW: -1, S0: 2, S1: 0 });
    await expect(new SystemOneBackend("http://localhost", "m").evaluate("task", members)).rejects.toThrow("probabilities");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(new SystemOneBackend("http://localhost", "m").evaluate("task", members)).rejects.toThrow("503");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await expect(new SystemOneBackend("http://localhost", "m").evaluate("a".repeat(4001), members)).rejects.toThrow("budget");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["file:///tmp/decisions", "https://user:password@example.com"])("rejects unsafe endpoint %s", url => {
    expect(() => new SystemOneBackend(url, "m")).toThrow("HTTP");
  });
  it("shortlists by current session context rather than the original goal", () => {
    const evolved = members.map(member => ({ ...member, summary: member.id === "auth" ? "Laya multilingual setup" : "OAuth callback tests" }));
    expect(shortlist("OAuth callback", evolved).map(item => item.id)).toEqual(["docker", "auth"]);
  });
  it("always includes the last visible member in the shortlist", () => {
    expect(shortlist("OAuth callback", members, "docker").map(item => item.id)).toEqual(["docker", "auth"]);
  });
});
