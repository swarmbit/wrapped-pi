import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { historyMessages, savedBranch } from "./history";

function message(id: string, parentId: string | null, timestamp: string, text: string): Extract<SessionEntry, { type: "message" }> {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: Date.parse(timestamp) } };
}
const time = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

describe("virtual chat history", () => {
  it("interleaves A → B → A chronologically without copying messages into model context", () => {
    const a = [message("a1", null, time(1), "First task"), message("a2", "a1", time(3), "Return to first")];
    const b = [message("b1", null, time(2), "Other task")];
    const before = JSON.stringify([a, b]);
    expect(historyMessages([a, b]).map(m => m.role === "user" ? m.content : undefined)).toEqual(["First task", "Other task", "Return to first"]);
    expect(JSON.stringify([a, b])).toBe(before);
  });

  it("reads only the saved active branch and excludes abandoned alternatives", () => {
    const root = message("root", null, time(1), "Root");
    const abandoned = message("abandoned", "root", time(2), "Abandoned");
    const chosen = message("chosen", "root", time(3), "Chosen");
    expect(savedBranch([root, abandoned, chosen])).toEqual([root, chosen]);
    expect(savedBranch([])).toEqual([]);
    expect(() => savedBranch([{ ...root, parentId: "root" }])).toThrow("Cyclic");
  });

  it("preserves pre-compaction messages and raw text omitted from model context", () => {
    const first = message("first", null, time(1), "Original text");
    const compact: SessionEntry = { type: "compaction", id: "compact", parentId: "first", timestamp: time(2), summary: "Summary", firstKeptEntryId: "compact", tokensBefore: 100 };
    expect(historyMessages([savedBranch([first, compact])]).map(m => m.role === "user" ? m.content : undefined)).toEqual(["Original text"]);
  });

  it("deduplicates copied entries but retains unrelated short-ID collisions and tool results", () => {
    const original = message("same", null, time(1), "Original");
    const copy = { ...original, parentId: "different-root" };
    const unrelated = message("same", null, time(2), "Unrelated");
    const tool = { type: "message", id: "tool", parentId: "same", timestamp: time(3), message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "Output" }], isError: false, timestamp: Date.parse(time(3)) } } as SessionEntry;
    expect(historyMessages([[original, tool], [copy, unrelated]])).toEqual([original.message, unrelated.message, (tool as any).message]);
  });
});
