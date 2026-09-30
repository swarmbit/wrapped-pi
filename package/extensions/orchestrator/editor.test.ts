import { describe, expect, it, vi } from "vitest";
import { decorateEditor, isOrdinarySubmission } from "./editor";

class TestEditor {
  #text = "draft";
  focused = false;
  mode = "normal";
  actionHandlers = new Map();
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onEscape?: () => void;
  history: string[] = [];
  getText() { return this.#text; }
  getExpandedText() { return this.#text + " expanded"; }
  setText(text: string) { this.#text = text; this.onChange?.(text); }
  addToHistory(text: string) { this.history.push(text); }
  handleInput(data: string) { if (data === "submit") this.onSubmit?.(this.#text); }
  render(_width: number) { return [this.#text]; }
  invalidate() {}
}

describe("editor submission decorator", () => {
  it("survives the host assigning onSubmit after factory construction", () => {
    const base = new TestEditor();
    const transform = vi.fn(text => `internal:${text}`);
    const editor = decorateEditor(base, transform);
    const host = vi.fn();
    editor.onSubmit = host;
    editor.handleInput("submit");
    expect(host).toHaveBeenCalledOnce();
    expect(host).toHaveBeenCalledWith("internal:draft");
    expect(transform).toHaveBeenCalledOnce();
    // Pi's follow-up shortcut invokes the editor callback directly.
    editor.onSubmit!("other");
    expect(host).toHaveBeenLastCalledWith("internal:other");
  });

  it("preserves private-field method receivers, optional capabilities, prototype and focus", () => {
    const base = new TestEditor();
    const editor = decorateEditor(base, text => text);
    expect(editor).toBeInstanceOf(TestEditor);
    editor.setText("hello");
    expect(editor.getText()).toBe("hello");
    expect(editor.getExpandedText!()).toBe("hello expanded");
    (editor as TestEditor).focused = true;
    expect(base.focused).toBe(true);
    expect((editor as TestEditor).mode).toBe("normal");
    (editor as TestEditor).actionHandlers.set("escape", vi.fn());
    expect(base.actionHandlers.size).toBe(1);
    expect(editor.render(80)).toEqual(["hello"]);
  });

  it("forwards change/control callbacks and preserves user history instead of transport commands", () => {
    const base = new TestEditor();
    const change = vi.fn();
    const escape = vi.fn();
    const editor = decorateEditor(base, text => text, text => text === "opaque-command" ? "original\ntext" : text);
    editor.onChange = change;
    (editor as TestEditor).onEscape = escape;
    editor.setText("changed");
    base.onEscape!();
    editor.addToHistory!("opaque-command");
    expect(change).toHaveBeenCalledWith("changed");
    expect(escape).toHaveBeenCalledOnce();
    expect(base.history).toEqual(["original\ntext"]);
  });

  it("does not wrap ordinary editing keys", () => {
    const transform = vi.fn(text => text);
    decorateEditor(new TestEditor(), transform).handleInput("h");
    expect(transform).not.toHaveBeenCalled();
  });
});

it.each(["/model", " /orchestrator off", "!ls", "!!pwd", "", "  "])("passes through control input %j", text => {
  expect(isOrdinarySubmission(text)).toBe(false);
});
it("accepts multiline prompts including command-like quoted content", () => {
  expect(isOrdinarySubmission("Explain this:\n/orchestrator off")).toBe(true);
});
