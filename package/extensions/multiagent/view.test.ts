import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MultiagentView } from "./view.js";
import type { MultiagentRuntime } from "./runtime.js";

beforeEach(() => { initTheme("dark", false); });
afterEach(() => vi.useRealTimers());
function setup() {
  const children = new Map([
    ["a", { id: "a", agent: "runner", status: "running", cwd: "/tmp", sessionFile: "/tmp/a.jsonl", messages: [
      { role: "user", content: "Find the bug", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Checking files…" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "src/main.ts" } }], stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "const answer = 42;" }], isError: false, timestamp: 3 },
    ], tools: new Map(), queue: { steering: [], followUp: [] } }],
    ["b", { id: "b", agent: "reviewer", status: "idle", cwd: "/tmp", sessionFile: "/tmp/b.jsonl", messages: [{ role: "user", content: "Review changes", timestamp: 1 }], tools: new Map(), queue: { steering: [], followUp: [] } }],
  ]);
  let listener = () => {};
  const unsubscribe = vi.fn();
  const runtime = { children, get: (id: string) => children.get(id), subscribe: (fn: () => void) => { listener = fn; return unsubscribe; },
    connect: vi.fn().mockResolvedValue({}), send: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
  const done = vi.fn(); const theme = { fg: (_token: string, text: string) => text };
  const view = new MultiagentView(runtime as unknown as MultiagentRuntime, "a", tui as any, theme as any, done);
  return { view, runtime, tui, done, unsubscribe, update: () => listener() };
}
describe("multiagent conversation view", () => {
  it("uses standalone message/tool history instead of a summary card, at narrow widths", () => {
    const { view } = setup();
    const rendered = view.render(80).join("\n");
    expect(rendered).toContain("Find the bug"); expect(rendered).toContain("Checking files"); expect(rendered).toContain("src/main.ts");
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
