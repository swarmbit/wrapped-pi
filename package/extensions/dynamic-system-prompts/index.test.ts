import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index";

vi.mock("../secret-redaction/state", () => ({ redactForLlm: (value: string) => value.replace(/private-token/g, "[redacted]") }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dynamic-prompts-"));
  mkdirSync(join(root, ".pi", "system-prompts"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  writeFileSync(join(root, ".pi", "system-prompts", "review.md"), "Review carefully. private-token");
  writeFileSync(join(root, ".pi", "system-prompts", "plan.md"), "Plan before coding.");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  let branch: any[] = [];
  const hooks: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const pi: any = {
    on: (name: string, fn: any) => { hooks[name] = fn; },
    registerCommand: (name: string, cmd: any) => { commands[name] = cmd; },
    appendEntry: vi.fn((customType, data) => branch.push({ type: "custom", customType, data })),
  };
  const ctx: any = {
    cwd: root, hasUI: true, isIdle: vi.fn(() => true),
    sessionManager: { getBranch: () => branch, getSessionId: () => "session-a" },
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() },
  };
  extension(pi);
  return { hooks, pi, ctx, command: (args = "") => commands["system-prompts"].handler(args, ctx),
    branch: () => branch, setBranch: (value: any[]) => { branch = value; } };
}
const start = (f: ReturnType<typeof fixture>, text = "Base prompt") => f.hooks.before_agent_start({ systemPrompt: text }, f.ctx);

describe("dynamic system prompts", () => {
  it("does not modify prompts until explicitly selected", () => expect(start(fixture())).toBeUndefined());
  it("selects by name, preserves the base prompt, and redacts outgoing content", async () => {
    const f = fixture();
    await f.command("review");
    expect(start(f)).toEqual({ systemPrompt: "Base prompt\n\nReview carefully. [redacted]" });
    expect(start(f)).toEqual(start(f));
    expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("dynamic-system-prompts", "System prompt: review");
  });
  it("replaces the active prompt and disables it", async () => {
    const f = fixture();
    await f.command("review");
    await f.command("plan");
    expect(start(f)?.systemPrompt).toBe("Base prompt\n\nPlan before coding.");
    await f.command("off");
    expect(start(f)).toBeUndefined();
    expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("dynamic-system-prompts", undefined);
  });
  it("restores the selected snapshot on reload even after the source file changes", async () => {
    const f = fixture();
    await f.command("plan");
    writeFileSync(join(root, ".pi", "system-prompts", "plan.md"), "Changed");
    const next = fixture();
    next.setBranch(f.branch());
    next.hooks.session_start({}, next.ctx);
    expect(start(next)?.systemPrompt).toContain("Plan before coding.");
    await next.command("plan");
    expect(start(next)?.systemPrompt).toContain("Changed");
  });
  it("follows branches and clears state in a new session", async () => {
    const f = fixture();
    await f.command("plan");
    const previous = [...f.branch()];
    await f.command("off");
    f.setBranch(previous);
    f.hooks.session_tree({}, f.ctx);
    expect(start(f)?.systemPrompt).toContain("Plan before coding.");
    f.setBranch([]);
    f.hooks.session_start({}, f.ctx);
    expect(start(f)).toBeUndefined();
  });
  it("shows a picker and preserves selection on cancellation", async () => {
    const f = fixture();
    f.ctx.ui.select.mockResolvedValue("plan (project)");
    await f.command();
    expect(start(f)?.systemPrompt).toContain("Plan before coding.");
    f.ctx.ui.select.mockResolvedValue(undefined);
    await f.command();
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(1);
    f.ctx.ui.select.mockResolvedValue("Disable dynamic system prompt");
    await f.command();
    expect(start(f)).toBeUndefined();
  });
  it("lists prompts and reports status without changing selection", async () => {
    const f = fixture();
    await f.command("list");
    await f.command("status");
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify).toHaveBeenLastCalledWith("No dynamic system prompt active.", "info");
  });
  it("does not change state for an unknown name or busy session", async () => {
    const f = fixture();
    await f.command("missing");
    f.ctx.isIdle.mockReturnValue(false);
    await f.command("plan");
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
  });
  it("supports explicit selection without UI", async () => {
    const f = fixture();
    f.ctx.hasUI = false;
    await f.command("plan");
    expect(start(f)?.systemPrompt).toContain("Plan before coding.");
    await f.command();
    expect(f.ctx.ui.select).not.toHaveBeenCalled();
  });
  it("cancels picker results if the agent became busy", async () => {
    const f = fixture();
    f.ctx.ui.select.mockImplementation(async () => {
      f.ctx.isIdle.mockReturnValue(false);
      return "plan (project)";
    });
    await f.command();
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
  });
});
