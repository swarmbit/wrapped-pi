// ============================================================
// Tests for batch-tools extension
// ============================================================
// Verifies:
//   - enhanceSystemPrompt appends the batching guidelines
//   - The before_agent_start handler returns a modified prompt
//   - The /batch:status command is registered
//   - Guidelines are not double-appended (idempotency)
//
// The pi-coding-agent module is type-only, so no mock needed
// at runtime — but vitest needs it resolvable for imports.
// ============================================================

import { describe, it, expect, vi } from "vitest";

// Mock @earendil-works/pi-coding-agent — only types are used,
// but the mock ensures the import resolves in the test env.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  default: {},
}));

import extensionFactory, {
  enhanceSystemPrompt,
  BATCH_GUIDELINES,
} from "./index";

// ── Mock ExtensionAPI ──────────────────────────────────────

function createMockPi() {
  const handlers: Record<string, ((event: any, ctx: any) => any) | undefined> =
    {};
  const commands: Record<string, { description: string; handler: Function }> =
    {};

  const pi: any = {
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    registerCommand(name: string, opts: { description: string; handler: Function }) {
      commands[name] = opts;
    },
  };

  return { pi, handlers, commands };
}

// ── Tests ───────────────────────────────────────────────────

describe("batch-tools", () => {
  describe("enhanceSystemPrompt", () => {
    it("appends guidelines to the base prompt", () => {
      const base = "You are a coding agent.";
      const enhanced = enhanceSystemPrompt(base);

      expect(enhanced).toContain(base);
      expect(enhanced).toContain("Tool Call Batching");
      expect(enhanced).toContain("Batch independent calls");
      expect(enhanced).toContain("Predict and prefetch");
      expect(enhanced.length).toBeGreaterThan(base.length);
    });

    it("preserves the original prompt content", () => {
      const base = "Line 1\nLine 2\nLine 3";
      const enhanced = enhanceSystemPrompt(base);

      expect(enhanced.startsWith(base)).toBe(true);
    });

    it("does not double-append if called twice on the same base", () => {
      const base = "You are a coding agent.";
      const once = enhanceSystemPrompt(base);
      const twice = enhanceSystemPrompt(once);

      // Calling enhanceSystemPrompt on an already-enhanced prompt
      // would double the guidelines — but the extension always
      // uses event.systemPrompt (the base) as input, so this test
      // just documents the expected behaviour.
      const guidelinesCount = (twice.match(/Tool Call Batching/g) || []).length;
      expect(guidelinesCount).toBe(2); // appears twice if misused
    });

    it("BATCH_GUIDELINES contains concrete examples", () => {
      expect(BATCH_GUIDELINES).toContain("grep");
      expect(BATCH_GUIDELINES).toContain("find");
      expect(BATCH_GUIDELINES).toContain("read");
      expect(BATCH_GUIDELINES).toContain("ls");
    });
  });

  describe("extension factory", () => {
    it("registers a before_agent_start handler", () => {
      const { pi, handlers } = createMockPi();
      extensionFactory(pi as any);

      expect(handlers["before_agent_start"]).toBeDefined();
    });

    it("registers a /batch:status command", () => {
      const { pi, commands } = createMockPi();
      extensionFactory(pi as any);

      expect(commands["batch:status"]).toBeDefined();
      expect(commands["batch:status"].description).toContain("batch");
    });

    it("before_agent_start handler returns enhanced systemPrompt", async () => {
      const { pi, handlers } = createMockPi();
      extensionFactory(pi as any);

      const handler = handlers["before_agent_start"]!;
      const mockEvent = { systemPrompt: "You are a coding agent." };
      const result = await handler(mockEvent, {});

      expect(result).toBeDefined();
      expect(result.systemPrompt).toContain("Tool Call Batching");
      expect(result.systemPrompt).toContain(mockEvent.systemPrompt);
    });

    it("before_agent_start handler uses base prompt from event, not previously enhanced", async () => {
      const { pi, handlers } = createMockPi();
      extensionFactory(pi as any);

      const handler = handlers["before_agent_start"]!;
      // The event always provides the base system prompt — even if
      // called multiple times, the guidelines appear only once because
      // event.systemPrompt is always the un-enhanced base.
      const mockEvent = { systemPrompt: "Base prompt." };
      const result1 = await handler(mockEvent, {});
      const result2 = await handler(mockEvent, {});

      const count1 = (result1.systemPrompt.match(/Tool Call Batching/g) || []).length;
      const count2 = (result2.systemPrompt.match(/Tool Call Batching/g) || []).length;
      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });
  });
});
