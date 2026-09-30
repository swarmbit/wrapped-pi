import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionContextSummary } from "./context-summary";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } }) as SessionEntry;

describe("session context summary", () => {
  it("keeps full text and tool calls but excludes results and thinking", () => {
    const user = `Configure Laya multilingual ${"x".repeat(4000)}`;
    const args = { command: `inspect ${"y".repeat(2000)}` };
    const summary = sessionContextSummary([
      message("user", user),
      message("assistant", [{ type: "thinking", thinking: "Private reasoning" },
        { type: "toolCall", name: "bash", arguments: args }]),
      message("toolResult", "Private tool output"),
      message("assistant", [{ type: "text", text: "Laya is configured" }]),
    ]);
    expect(summary).toMatch(/^Latest message:\nassistant: Laya is configured/);
    expect(summary).toContain(user);
    expect(summary).toContain(`tool call: bash ${JSON.stringify(args)}`);
    expect(summary).not.toContain("Private tool output");
    expect(summary).not.toContain("Private reasoning");
  });
  it("retains ten nonempty user/assistant messages, newest first, without truncation", () => {
    const entries = Array.from({ length: 12 }, (_, i) => message("user", `Message ${i}: ${"x".repeat(1000)}`));
    const summary = sessionContextSummary([...entries, message("assistant", []), message("toolResult", "output")]);
    expect(summary).toMatch(/^Latest message:\nuser: Message 11:/);
    expect(summary).toContain(`Message 2: ${"x".repeat(1000)}`);
    expect(summary).not.toContain("Message 1:");
    expect(summary.match(/user: /g)).toHaveLength(10);
    expect(summary.length).toBeGreaterThan(10_000);
    expect(sessionContextSummary([...entries, message("user", "New context")])).toMatch(/^Latest message:\nuser: New context/);
  });
  it("counts call-only assistant messages among the ten messages", () => {
    const summary = sessionContextSummary([message("user", "Old request"),
      ...Array.from({ length: 10 }, (_, i) => message("assistant", [{ type: "toolCall", name: "read", arguments: { path: `file-${i}` } }]))]);
    expect(summary).not.toContain("Old request");
    expect(summary.match(/tool call: read/g)).toHaveLength(10);
  });
});
