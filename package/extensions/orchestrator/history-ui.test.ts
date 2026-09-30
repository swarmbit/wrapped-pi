import { describe, expect, it, vi } from "vitest";
import { bindChatHistory } from "./history-ui";

function fixture() {
  class Mode {
    ui = {};
    sessionManager = {} as any;
    context = { messages: [{ role: "user", content: "Native" }], entries: [] } as any;
    displayed: any;
    renderSessionContext(context: any) { this.displayed = context; }
    rebuildChatFromMessages() { this.renderSessionContext(this.context); }
  }
  return Mode;
}

describe("native main-chat compatibility adapter", () => {
  it("projects main chat only, rebuilds on enable/disable, and leaves model context untouched", () => {
    const Mode = fixture();
    const mode = new Mode();
    const other = new Mode();
    const original = mode.context;
    const projection = vi.fn((_manager, ctx) => ({ ...ctx, messages: [{ role: "user", content: "Combined" }] }));
    const handle = bindChatHistory(mode.ui, projection, Mode.prototype as any)!;
    mode.rebuildChatFromMessages();
    expect(mode.displayed.messages[0].content).toBe("Combined");
    expect(mode.context).toBe(original);
    expect(mode.context.messages[0].content).toBe("Native");
    other.rebuildChatFromMessages();
    expect(other.displayed).toBe(other.context);
    handle.dispose(true);
    expect(mode.displayed).toBe(mode.context);
  });

  it("uses one wrapper across reloads and old cleanup cannot detach the new binding", () => {
    const Mode = fixture();
    const mode = new Mode();
    const old = bindChatHistory(mode.ui, (_manager, context) => context, Mode.prototype as any)!;
    mode.rebuildChatFromMessages();
    const wrapper = Mode.prototype.renderSessionContext;
    const project = vi.fn((_manager, context) => context);
    const next = bindChatHistory(mode.ui, project, Mode.prototype as any)!;
    expect(Mode.prototype.renderSessionContext).toBe(wrapper);
    old.dispose(true);
    next.refresh();
    expect(project).toHaveBeenCalledTimes(2);
    next.dispose();
    mode.rebuildChatFromMessages();
    expect(project).toHaveBeenCalledTimes(2);
  });

  it("falls back to native rendering on projection errors or unsupported Pi APIs", () => {
    const Mode = fixture();
    const mode = new Mode();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      bindChatHistory(mode.ui, () => { throw new Error("Corrupt transcript"); }, Mode.prototype as any);
      mode.rebuildChatFromMessages();
      expect(mode.displayed).toBe(mode.context);
      expect(log).toHaveBeenCalled();
      expect(bindChatHistory({}, () => mode.context, {} as any)).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});
