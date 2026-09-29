import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemOneBackend, shortlist } from "./decision";
import type { MemberSession } from "./types";
const members: MemberSession[] = [
  { id: "auth", virtualId: "v", file: "a", name: "OAuth", goal: "Implement OAuth callback", summary: "PKCE tests", lastActivityAt: "2026-01-01", origin: "created", baselineSources: [] },
  { id: "docker", virtualId: "v", file: "b", name: "Docker", goal: "Docker networking", summary: "Ports", lastActivityAt: "2026-01-02", origin: "created", baselineSources: [] },
];
afterEach(() => vi.unstubAllGlobals());
function response(choice: string, probabilities: Record<string, number>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { route: { choice, probabilities } }, usage: { input_tokens: 42, output_tokens: 0 } }))));
}

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
  });
  it("selects independent work only at a sufficient score margin", async () => {
    response("NEW", { NEW: 0.96, S0: 0.02, S1: 0.02 });
    expect((await new SystemOneBackend("http://localhost", "m").evaluate("New task", members)).decision.action).toBe("new");
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
  it("always includes the last visible member in the shortlist", () => {
    expect(shortlist("OAuth callback", members, "docker").map(item => item.id)).toEqual(["docker", "auth"]);
  });
});
