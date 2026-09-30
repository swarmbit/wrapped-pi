import { describe, expect, it, vi } from "vitest";
import { bindChatHistory } from "./history-ui";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

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

function entriesFixture() {
  class Mode {
    ui = {};
    entries = [{ type: "message", message: { role: "user", content: "Native" } }] as any;
    sessionManager = { buildContextEntries: () => this.entries } as any;
    displayed: any;
    options: any;
    renderSessionItems(items: any, options?: any) { this.displayed = items; this.options = options; }
    renderSessionEntries(entries: any, options?: any) {
      this.renderSessionItems(entries.map((entry: any) => entry.message), options);
    }
    renderInitialMessages() {
      this.renderSessionEntries(this.sessionManager.buildContextEntries(), { populateHistory: true, updateFooter: true });
    }
    rebuildChatFromMessages() { this.renderSessionEntries(this.sessionManager.buildContextEntries()); }
  }
  return Mode;
}

describe("native main-chat compatibility adapter", () => {
  it("supports the installed Pi renderer API", () => {
    const prototype = InteractiveMode.prototype as any;
    expect(typeof prototype.rebuildChatFromMessages).toBe("function");
    expect(typeof prototype.renderSessionContext === "function" ||
      (typeof prototype.renderSessionEntries === "function" &&
       typeof prototype.renderSessionItems === "function" &&
       typeof prototype.renderInitialMessages === "function")).toBe(true);
  });

  it("projects Pi 0.99.1 full renders, preserves options and native entry slices", () => {
    const Mode = entriesFixture();
    const mode = new Mode();
    const other = new Mode();
    const entries = mode.entries;
    const messages = [{ role: "user", content: "Combined" }];
    const projection = vi.fn((_manager, context) => ({ ...context, messages }));
    const handle = bindChatHistory(mode.ui, projection, Mode.prototype as any)!;
    expect(handle).toBeDefined();
    mode.renderInitialMessages();
    expect(mode.displayed).toBe(messages);
    expect(mode.options).toEqual({ populateHistory: true, updateFooter: true });
    expect(mode.entries).toBe(entries);
    expect(mode.entries[0].message.content).toBe("Native");
    other.rebuildChatFromMessages();
    expect(other.displayed[0].content).toBe("Native");
    const slice = [{ type: "message", message: { role: "user", content: "Slice" } }];
    mode.renderSessionEntries(slice);
    expect(mode.displayed[0].content).toBe("Slice");
    expect(projection).toHaveBeenCalledTimes(1);
    handle.refresh();
    expect(mode.displayed).toBe(messages);
    handle.dispose(true);
    expect(mode.displayed[0].content).toBe("Native");
  });

  it("keeps one entries wrapper across reloads and restores native rendering on errors", () => {
    const Mode = entriesFixture();
    const mode = new Mode();
    const old = bindChatHistory(mode.ui, (_manager, context) => ({ ...context, messages: [] }), Mode.prototype as any)!;
    mode.renderInitialMessages();
    const wrapper = Mode.prototype.renderSessionEntries;
    const project = vi.fn((_manager, context) => context);
    const next = bindChatHistory(mode.ui, project, Mode.prototype as any)!;
    expect(Mode.prototype.renderSessionEntries).toBe(wrapper);
    expect(mode.displayed[0].content).toBe("Native");
    old.dispose(true);
    next.refresh();
    expect(project).toHaveBeenCalledTimes(2);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = bindChatHistory(mode.ui, () => { throw new Error("Corrupt transcript"); }, Mode.prototype as any)!;
      expect(mode.displayed[0].content).toBe("Native");
      expect(log).toHaveBeenCalled();
      failed.dispose(true);
    } finally { log.mockRestore(); }
  });
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
