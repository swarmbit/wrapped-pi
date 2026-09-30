import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPrompts, MAX_PROMPT_BYTES } from "./prompts";

let root: string;
let cwd: string;
let agent: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "system-prompts-"));
  cwd = join(root, "project");
  agent = join(root, "agent");
  mkdirSync(join(cwd, ".pi", "system-prompts"), { recursive: true });
  mkdirSync(join(agent, "system-prompts"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const project = (name: string, text: string) => writeFileSync(join(cwd, ".pi", "system-prompts", name), text);
const user = (name: string, text: string) => writeFileSync(join(agent, "system-prompts", name), text);

describe("system prompt discovery", () => {
  it("accepts missing directories", () => expect(loadPrompts(join(root, "missing"), join(root, "missing-agent"))).toEqual([]));
  it("loads Markdown, strips metadata, and lets project names override user names", () => {
    user("review.md", "User review");
    user("plan.md", "Plan first");
    project("review.md", "---\r\ndescription: Review changes\r\n---\r\nProject review\n");
    expect(loadPrompts(cwd, agent)).toEqual([
      { name: "plan", description: "", content: "Plan first", source: "user" },
      { name: "review", description: "Review changes", content: "Project review", source: "project" },
    ]);
  });
  it("ignores other files, nested directories, and symlinks", () => {
    project("note.txt", "Ignored");
    mkdirSync(join(cwd, ".pi", "system-prompts", "nested"));
    symlinkSync(join(cwd, ".pi", "system-prompts", "note.txt"), join(cwd, ".pi", "system-prompts", "link.md"));
    expect(loadPrompts(cwd, agent)).toEqual([]);
  });
  it.each(["", " ", "---\ndescription: [invalid]\n---\nPrompt", "x".repeat(MAX_PROMPT_BYTES + 1)])("rejects invalid prompts without exposing contents", text => {
    project("review.md", text);
    expect(() => loadPrompts(cwd, agent)).toThrow("Invalid project system prompt review.md");
  });
  it.each(["off", "status", "list"])("rejects reserved name %s", name => {
    project(`${name}.md`, "Prompt");
    expect(() => loadPrompts(cwd, agent)).toThrow("Reserved");
  });
  it("reads edits on each selection", () => {
    project("review.md", "First");
    expect(loadPrompts(cwd, agent)[0].content).toBe("First");
    project("review.md", "Second");
    expect(loadPrompts(cwd, agent)[0].content).toBe("Second");
  });
});
