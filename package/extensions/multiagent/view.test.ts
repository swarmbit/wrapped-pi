import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MultiagentView } from "./view.js";
import { INCOMING_MAIL } from "./mailbox.js";
import type { MultiagentRuntime } from "./runtime.js";

beforeEach(() => { initTheme("dark", false); });
afterEach(() => vi.useRealTimers());
function setup() {
  const children = new Map([
    ["a", { id: "a", agent: "runner", status: "running", cwd: "/tmp", sessionFile: "/tmp/a.jsonl", messages: [
      { role: "user", content: "Find the bug", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "Inspect this image" }, { type: "image", data: "not-rendered" }], timestamp: 1.5 },
      { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Checking files…" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "src/main.ts" } }], provider: "openai-codex", model: "gpt-6-luna", usage: { cost: { total: 0.025 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "compactionSummary", summary: "Earlier findings", tokensBefore: 200, timestamp: 2.5 },
      { role: "branchSummary", summary: "Alternative branch note", fromId: "old", timestamp: 2.6 },
      { role: "custom", customType: INCOMING_MAIL, display: true, content: "fallback content", details: { kind: "question", agent: "runner", childId: "a", id: "mail-1", text: "Need the API decision", receivedAt: 1, acknowledged: false }, timestamp: 2.7 },
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "const answer = 42;" }], isError: false, timestamp: 3 },
      { role: "assistant", content: [
        { type: "toolCall", id: "edit-call", name: "edit", arguments: { path: "src/main.ts", edits: [{ oldText: "42", newText: "43" }] } },
        { type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "npm test" } },
        { type: "toolCall", id: "custom-call", name: "custom_tool", arguments: { path: "src/main.ts", options: { safe: true } } },
      ], provider: "openai-codex", model: "gpt-6-luna", stopReason: "toolUse", timestamp: 4 },
      { role: "toolResult", toolCallId: "edit-call", toolName: "edit", content: [{ type: "text", text: "Edited" }], details: { diff: "--- a/src/main.ts\n+++ b/src/main.ts\n-old\n+new", patch: "" }, isError: false, timestamp: 5 },
      { role: "toolResult", toolCallId: "bash-call", toolName: "bash", content: [{ type: "text", text: "hello\nexit code: 0" }], details: { exitCode: 0 }, isError: false, timestamp: 6 },
      { role: "toolResult", toolCallId: "custom-call", toolName: "custom_tool", content: [{ type: "text", text: "Completed" }], isError: false, timestamp: 7 },
    ], tools: new Map(), queue: { steering: ["Please let the edit finish"], followUp: ["Run tests afterward"] } }],
    ["b", { id: "b", agent: "reviewer", status: "idle", cwd: "/tmp", sessionFile: "/tmp/b.jsonl", messages: [{ role: "user", content: "Review changes", timestamp: 1 }], tools: new Map(), queue: { steering: [], followUp: [] } }],
  ]);
  let listener = () => {};
  const unsubscribe = vi.fn();
  const runtime = { children, get: (id: string) => children.get(id), subscribe: (fn: () => void) => { listener = fn; return unsubscribe; },
    connect: vi.fn().mockResolvedValue({}), send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
  const tui = { terminal: { rows: 60 }, requestRender: vi.fn() };
  const done = vi.fn(); const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text };
  const view = new MultiagentView(runtime as unknown as MultiagentRuntime, "a", tui as any, theme as any, done);
  return { view, runtime, tui, done, unsubscribe, update: () => listener() };
}
describe("multiagent conversation view", () => {
  it("uses standalone message/tool history instead of a summary card, at narrow widths", () => {
    const { view } = setup();
    const rendered = view.render(80).join("\n");
    expect(rendered).toContain("Find the bug"); expect(rendered).toContain("Inspect this image"); expect(rendered).toContain("[image]");
    expect(rendered).toContain("Checking files"); expect(rendered).toContain("src/main.ts"); expect(rendered).not.toContain("private reasoning");
    expect(rendered).toContain("edit"); expect(rendered).toContain("+new"); expect(rendered).toContain("$ npm test"); expect(rendered).toContain("exit code: 0");
    expect(rendered).toContain("custom_tool · path: src/main.ts · options: {…}");
    expect(rendered).not.toContain('"command": "npm test"');
    expect(rendered).toContain("Steer queued: Please let the edit finish"); expect(rendered).toContain("Follow-up queued: Run tests afterward");
    expect(rendered).toContain("Model: openai-codex/gpt-6-luna · Session cost: $0.0250");
    expect(rendered).toContain("Compacted from 200 tokens"); expect(rendered).toContain("Branch summary");
    expect(rendered).toContain("QUESTION from runner (a)"); expect(rendered).toContain("Need the API decision");
    for (const width of [20, 40, 80]) {
      view.invalidate();
      expect(view.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    }
    view.dispose();
  });
  it("switches conversations, sends steering/follow-ups, and stops only the selected agent", async () => {
    const { view, runtime } = setup(); view.focused = true; expect(view.focused).toBe(true);
    view.handleInput("\t"); await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.render(80).join("\n")).toContain("Review changes");
    view.handleInput("do this"); view.handleInput("\r"); await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.send).toHaveBeenLastCalledWith("b", "do this", "steer");
    view.handleInput("\x14"); view.handleInput("then test"); view.handleInput("\r"); await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.send).toHaveBeenLastCalledWith("b", "then test", "followUp");
    view.handleInput("\x13"); await new Promise(resolve => setTimeout(resolve, 0)); expect(runtime.stop).toHaveBeenCalledWith("b");
    view.dispose();
  });
  it("closing the view does not abort children and cancels repaint subscriptions", () => {
    vi.useFakeTimers(); const { view, update, done, runtime, unsubscribe, tui } = setup();
    update(); view.handleInput("\x1b"); expect(done).toHaveBeenCalledOnce(); expect(runtime.stop).not.toHaveBeenCalled();
    view.dispose(); expect(unsubscribe).toHaveBeenCalledOnce(); vi.runAllTimers(); expect(tui.requestRender).not.toHaveBeenCalled();
  });
});
