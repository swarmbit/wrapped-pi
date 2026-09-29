import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionContextSummary } from "./context-summary";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } }) as SessionEntry;

describe("session context summary", () => {
  it("keeps the recent user request despite empty tool-call assistant messages", () => {
    const summary = sessionContextSummary([
      message("user", "Let's commit"), message("assistant", "Committed"),
      message("user", "Configure Laya multilingual"),
      ...Array.from({ length: 8 }, () => message("assistant", [])),
      message("toolResult", "Private tool output"),
      message("assistant", [{ type: "text", text: "Laya is configured" }]),
    ]);
    expect(summary).toMatch(/^Latest turn:\nuser: Configure Laya multilingual/);
    expect(summary).toContain("assistant: Laya is configured");
    expect(summary).not.toContain("Private tool output");
  });
  it("updates with each turn and bounds the summary with newest context first", () => {
    const entries = Array.from({ length: 6 }, (_, i) => message("user", `Turn ${i} ${"x".repeat(1000)}`));
    const summary = sessionContextSummary(entries);
    expect(summary).toMatch(/^Latest turn:\nuser: Turn 5/);
    expect(summary).toContain("Turn 3");
    expect(summary).not.toContain("Turn 2");
    expect(summary.length).toBeLessThanOrEqual(1500);
    expect(sessionContextSummary([...entries, message("user", "New context")])).toMatch(/^Latest turn:\nuser: New context/);
  });
});
