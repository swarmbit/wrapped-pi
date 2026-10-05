import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { decodeSessionContextSummary, readableSessionContextSummary, sessionContextSummary } from "./context-summary";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } }) as SessionEntry;

describe("session context summary", () => {
  it("stores structured full user/assistant text, newest first, excluding tool calls, reasoning and images", () => {
    const user = `Configure Laya ${"x".repeat(4000)}`;
    const summary = sessionContextSummary([message("user", user), message("assistant", [
      { type: "thinking", thinking: "Private reasoning" }, { type: "toolCall", arguments: { command: "secret" } },
      { type: "text", text: "Checking" }, { type: "image", data: "image" },
    ]), message("toolResult", "private"), message("assistant", [{ type: "text", text: "Done" }])]);
    expect(JSON.parse(summary)).toEqual([{ role: "assistant", content: "Done" }, { role: "assistant", content: "Checking" }, { role: "user", content: user }]);
    expect(summary).not.toContain("reasoning");
    expect(summary).not.toContain("secret");
  });
  it("retains 50 nonempty messages and excludes empty messages", () => {
    const entries = Array.from({ length: 52 }, (_, i) => message("user", `Message ${i}: ${"x".repeat(1000)}`));
    const summary = sessionContextSummary([...entries, message("assistant", []), message("user", "  ")]);
    const decoded = JSON.parse(summary);
    expect(decoded).toHaveLength(50);
    expect(decoded[0].content).toContain("Message 51:");
    expect(decoded[49].content).toContain("Message 2:");
    expect(summary.length).toBeGreaterThan(50000);
    expect(sessionContextSummary([])).toBe("[]");
  });
  it("decodes structured summaries defensively and projects them readably", () => {
    const valid = JSON.stringify([{ role: "user", content: "hello", extra: "ignored" }]);
    expect(decodeSessionContextSummary(valid)).toEqual([{ role: "user", content: "hello" }]);
    expect(decodeSessionContextSummary("invalid JSON")).toEqual([]);
    expect(decodeSessionContextSummary('[{"role":"system","content":"x"}]')).toEqual([]);
    expect(decodeSessionContextSummary('[{"role":"user","content":2}]')).toEqual([]);
    expect(readableSessionContextSummary(valid)).toContain("user: hello");
    expect(readableSessionContextSummary("invalid JSON")).toBe("");
  });
  it("separates readable messages with real line breaks, newest first", () => {
    const summary = sessionContextSummary([message("user", "Fix the bug"), message("assistant", [{ type: "text", text: "Done" }])]);
    expect(readableSessionContextSummary(summary)).toBe("Latest message:\nassistant: Done\n\nEarlier message:\nuser: Fix the bug");
    expect(readableSessionContextSummary(summary)).not.toContain("\\n");
  });
});
