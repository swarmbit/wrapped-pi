import { describe, expect, it } from "vitest";
import { compactUsage, emptyUsage, extractUsage, formatTokens, normalizeUsage, savedContextTokens, sumUsage, usageLine } from "./usage";

const usage = { input: 10, output: 2, cacheRead: 100, cacheWrite: 20, totalTokens: 999, cost: { total: 0.2 } };
const assistant = { type: "message", id: "entry-1", timestamp: "2026-01-01", message: {
  role: "assistant", timestamp: 123, provider: "provider", model: "sol", usage,
} };

describe("usage accounting", () => {
  it("formats compact counters like the normal Pi footer", () => {
    expect([0, 999, 1000, 9999, 10000, 999999, 1000000, 10000000].map(formatTokens))
      .toEqual(["0", "999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10M"]);
    expect(compactUsage(normalizeUsage(usage))).toBe("~$0.2000 ↑10 ↓2 R100 W20");
    expect(compactUsage(emptyUsage())).toBe("~$0.0000");
    expect(compactUsage(normalizeUsage(undefined))).toBe("partial $0.0000 (partial tokens)");
  });
  it("estimates saved context from the leaf branch rather than lifetime totals", () => {
    const earlier = { ...assistant, id: "earlier", parentId: null };
    const abandoned = { ...assistant, id: "abandoned", parentId: "earlier",
      message: { ...assistant.message, usage: { ...usage, input: 9999 } } };
    const leaf = { type: "message", id: "leaf", parentId: "earlier", message: { role: "user" } };
    expect(savedContextTokens([earlier, abandoned, leaf])).toBe(132);
    expect(savedContextTokens([assistant, { type: "compaction", id: "summary" }])).toBeNull();
    expect(savedContextTokens([{ ...assistant, message: { role: "assistant" } }])).toBeNull();
    expect(savedContextTokens([])).toBeNull();
    expect(savedContextTokens([{ id: "cycle", parentId: "cycle" }])).toBeNull();
  });
  it("uses mutually exclusive normalized categories, not raw totals", () => {
    expect(normalizeUsage(usage)).toEqual({ input: 10, output: 2, cacheRead: 100, cacheWrite: 20,
      totalTokens: 132, cost: 0.2, incompleteTokens: false, incompleteCost: false });
  });
  it("exposes missing/invalid fields without pretending they are known zero", () => {
    const result = normalizeUsage({ input: -10, output: Infinity, cacheRead: NaN });
    expect(result.totalTokens).toBe(0);
    expect(result.incompleteTokens).toBe(true);
    expect(result.incompleteCost).toBe(true);
    expect(usageLine("total", result)).toContain("partial");
  });
  it("tracks summaries and warming separately, including legacy accounting gaps", () => {
    const entries = [assistant, { type: "usage", id: "warm", timestamp: "2026-01-02", kind: "cache_warm", usage },
      { type: "compaction", id: "summary", timestamp: "2026-01-03", summary: "Legacy summary" },
      { type: "message", id: "user", message: { role: "user" } }];
    const result = extractUsage(entries, "real");
    expect(result.map(item => item.category)).toEqual(["worker", "warming", "summary"]);
    expect(result[2].usage.incompleteCost).toBe(true);
    expect(sumUsage(result.map(item => item.usage)).cost).toBe(0.4);
  });
  it("keeps copied-entry identity stable across session files", () => {
    expect(extractUsage([assistant], "original")[0].source).toBe(extractUsage([assistant], "clone")[0].source);
    expect(extractUsage([{ ...assistant, id: "new-call" }], "clone")[0].source).not.toBe(extractUsage([assistant], "original")[0].source);
  });
  it("includes nested tool inference usage once", () => {
    const result = extractUsage([{ type: "message", id: "tool", timestamp: "2026-01-04", message: { role: "toolResult", toolCallId: "abc", usage } }], "real");
    expect(result[0].category).toBe("tool");
    expect(result[0].usage.cost).toBe(0.2);
  });
  it("does not confuse accumulated tokens with context size", () => {
    const result = sumUsage([normalizeUsage(usage), normalizeUsage(usage)]);
    expect(result.totalTokens).toBe(264);
    expect(result.cacheRead).toBe(200);
  });
});
