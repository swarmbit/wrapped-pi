import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionContextSummary } from "./context-summary";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } }) as SessionEntry;

describe("session context summary", () => {
  it("keeps full user/assistant text but excludes tool calls, results, and reasoning", () => {
    const user = `Configure Laya multilingual ${"x".repeat(4000)}`;
    const args = { command: `inspect ${"y".repeat(2000)}` };
    const summary = sessionContextSummary([
      message("user", user),
      message("assistant", [{ type: "thinking", thinking: "Private reasoning" },
        { type: "toolCall", name: "bash", arguments: args },
        { type: "text", text: "Checking configuration" },
        { type: "image", data: "Private image" }]),
      message("toolResult", "Private tool output"),
      message("assistant", [{ type: "text", text: "Laya is configured" }]),
    ]);
    expect(summary).toMatch(/^Latest message:\nassistant: Laya is configured/);
    expect(summary).toContain(user);
    expect(summary).toContain("assistant: Checking configuration");
    expect(summary).not.toContain("tool call:");
    expect(summary).not.toContain(args.command);
    expect(summary).not.toContain("Private tool output");
    expect(summary).not.toContain("Private reasoning");
    expect(summary).not.toContain("Private image");
  });
  it("retains 50 nonempty user/assistant messages, newest first, without truncation", () => {
    const entries = Array.from({ length: 52 }, (_, i) => message("user", `Message ${i}: ${"x".repeat(1000)}`));
    const summary = sessionContextSummary([...entries, message("assistant", []), message("toolResult", "output")]);
    expect(summary).toMatch(/^Latest message:\nuser: Message 51:/);
    expect(summary).toContain(`Message 2: ${"x".repeat(1000)}`);
    expect(summary).not.toContain("Message 1:");
    expect(summary.match(/user: /g)).toHaveLength(50);
    expect(summary.length).toBeGreaterThan(50_000);
    expect(sessionContextSummary([...entries, message("user", "New context")])).toMatch(/^Latest message:\nuser: New context/);
  });
  it("ignores call-only, reasoning-only, and whitespace-only messages without consuming the limit", () => {
    const summary = sessionContextSummary([message("user", "Old request"),
      ...Array.from({ length: 60 }, (_, i) => message("assistant", [{ type: "toolCall", name: "read", arguments: { path: `file-${i}` } }])),
      message("assistant", [{ type: "thinking", thinking: "Private reasoning" }]),
      message("user", " \n\t "), message("assistant", [{ type: "text", text: "  " }]),
    ]);
    expect(summary).toBe("Latest message:\nuser: Old request");
  });
  it("counts user and assistant replies together toward the 50-message limit", () => {
    const entries = Array.from({ length: 51 }, (_, i) => message(i % 2 ? "assistant" : "user", `Message ${i}`));
    const summary = sessionContextSummary(entries);
    expect(summary).not.toContain("Message 0\n");
    expect(summary).toContain("assistant: Message 1");
    expect(summary.match(/(?:user|assistant): /g)).toHaveLength(50);
  });
});
