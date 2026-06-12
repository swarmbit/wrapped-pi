// ============================================================
// Tests for llm-log Markdown formatters
// ============================================================

import { describe, it, expect } from "vitest";
import {
	formatMessage,
	formatRequest,
	formatResponse,
	formatSessionHeader,
	formatTools,
	formatProviderPayload,
	formatResponseMeta,
	type AssistantMessage,
	type FormattableMessage,
	type ToolResultMessage,
	type ToolInfo,
	type UserMessage,
} from "./format.js";

// ── Fixtures ─────────────────────────────────────────────────

const baseUsage = {
	input: 1234,
	output: 56,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1290,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
};

function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello!" }],
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		api: "anthropic-messages",
		usage: baseUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

function makeUser(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function makeToolResult(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "toolu_abc",
		toolName: "read",
		content: [{ type: "text", text: "file contents here" }],
		isError: false,
		timestamp: Date.now(),
		...overrides,
	} as ToolResultMessage;
}

const noTools: ToolInfo[] = [];
const sampleTools: ToolInfo[] = [
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

// ── formatSessionHeader ──────────────────────────────────────

describe("formatSessionHeader", () => {
	it("renders title, session id, and started time", () => {
		const md = formatSessionHeader({
			sessionFile: "/sessions/abc/sess-123.jsonl",
			sessionId: "sess-123",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
			startedAt: "2026-06-12T12:00:00.000Z",
		});

		expect(md).toContain("# LLM Log");
		expect(md).toContain("**Session ID:** `sess-123`");
		expect(md).toContain("**Session file:** `/sessions/abc/sess-123.jsonl`");
		expect(md).toContain("**Initial model:** anthropic/claude-sonnet-4-5");
		expect(md).toContain("**Started:** 2026-06-12T12:00:00.000Z");
	});

	it("marks ephemeral sessions", () => {
		const md = formatSessionHeader({
			sessionFile: null,
			sessionId: "ephemeral",
			model: null,
			startedAt: "2026-06-12T12:00:00.000Z",
		});

		expect(md).toContain("**Session file:** *(ephemeral)*");
		expect(md).not.toContain("**Initial model:**");
	});
});

// ── formatMessage (per-role differentiation) ────────────────

describe("formatMessage — role differentiation", () => {
	it("labels user messages with 👤 User", () => {
		const md = formatMessage(makeUser("hi there"), 0);
		expect(md).toContain("👤 User");
		expect(md).toContain("hi there");
	});

	it("labels assistant messages with 🤖 Assistant", () => {
		const md = formatMessage(makeAssistant(), 0);
		expect(md).toContain("🤖 Assistant");
		expect(md).toContain("Hello!");
	});

	it("labels toolResult messages with 🔧 and tool name", () => {
		const md = formatMessage(makeToolResult(), 0);
		expect(md).toContain("🔧");
		expect(md).toContain("`read`");
		expect(md).toContain("`toolu_abc`");
		expect(md).toContain("✓ success");
	});

	it("shows ✗ error for failed tool results", () => {
		const md = formatMessage(makeToolResult({ isError: true }), 0);
		expect(md).toContain("✗ error");
	});

	it("numbers messages sequentially", () => {
		const md1 = formatMessage(makeUser("a"), 0);
		const md5 = formatMessage(makeUser("e"), 4);
		expect(md1).toContain("**#1 —");
		expect(md5).toContain("**#5 —");
	});

	it("handles custom roles with 📦 and JSON dump", () => {
		const custom: FormattableMessage = {
			role: "bashExecution",
			command: "ls",
			output: "file.txt",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		} as FormattableMessage;
		const md = formatMessage(custom, 0);
		expect(md).toContain("📦 bashExecution");
		expect(md).toContain("```json");
	});
});

// ── formatMessage — content block differentiation ────────────

describe("formatMessage — content block differentiation", () => {
	it("shows plain text for assistant text blocks", () => {
		const md = formatMessage(makeAssistant({ content: [{ type: "text", text: "world" }] }), 0);
		expect(md).toContain("**Text:**");
		expect(md).toContain("world");
	});

	it("shows Thinking: label for thinking blocks", () => {
		const md = formatMessage(
			makeAssistant({ content: [{ type: "thinking", thinking: "let me think..." }] }),
			0,
		);
		expect(md).toContain("**Thinking:**");
		expect(md).toContain("let me think...");
	});

	it("renders tool calls as JSON code blocks with name and id", () => {
		const md = formatMessage(
			makeAssistant({
				content: [
					{
						type: "toolCall",
						id: "toolu_xyz",
						name: "bash",
						arguments: { command: "ls" },
					},
				],
			}),
			0,
		);
		expect(md).toContain("Tool call: `bash`");
		expect(md).toContain("`toolu_xyz`");
		expect(md).toContain("```json");
		expect(md).toContain('"command": "ls"');
	});

	it("does NOT dump base64 for image blocks", () => {
		const fakeBase64 = "A".repeat(100);
		const md = formatMessage(
			makeUser([{ type: "image", data: fakeBase64, mimeType: "image/png" }]),
			0,
		);
		expect(md).not.toContain("A".repeat(50)); // no base64 dump
		expect(md).toContain("[image: image/png");
		expect(md).toContain("bytes]");
	});

	it("collapses long tool results into <details>", () => {
		const longContent = "x".repeat(2000);
		const md = formatMessage(makeToolResult({ content: [{ type: "text", text: longContent }] }), 0);
		expect(md).toContain("<details>");
		expect(md).toContain("Show tool result");
	});

	it("keeps short tool results inline", () => {
		const md = formatMessage(makeToolResult({ content: [{ type: "text", text: "short" }] }), 0);
		expect(md).not.toContain("<details>");
		expect(md).toContain("```\nshort\n```");
	});
});

// ── formatRequest ────────────────────────────────────────────

describe("formatRequest", () => {
	it("renders turn header, request marker, model, system prompt, tools, and messages", () => {
		const md = formatRequest({
			turnIndex: 3,
			timestamp: "2026-06-12T12:34:56.789Z",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
			systemPrompt: "You are helpful.",
			tools: sampleTools,
			messages: [makeUser("hi")],
		});

		expect(md).toContain("## Turn 3 — 2026-06-12T12:34:56.789Z");
		expect(md).toContain("### → REQUEST");
		expect(md).toContain("anthropic/claude-sonnet-4-5");
		expect(md).toContain("You are helpful.");
		expect(md).toContain("Tools (1)");
		expect(md).toContain("**Messages (1):**");
		expect(md).toContain("👤 User");
	});

	it("collapses long system prompts into <details>", () => {
		const long = "x".repeat(1000);
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: long,
			tools: [],
			messages: [],
		});
		expect(md).toContain("1,000 chars");
		expect(md).toContain("<details>");
		expect(md).toContain("Show system prompt");
	});

	it("keeps short system prompts inline", () => {
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "short",
			tools: [],
			messages: [],
		});
		expect(md).toContain("```\nshort\n```");
		expect(md).not.toContain("Show system prompt");
	});

	it("shows *(no messages)* for empty context", () => {
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "",
			tools: noTools,
			messages: [],
		});
		expect(md).toContain("*(no messages)*");
	});

	it("labels unknown model gracefully", () => {
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "",
			tools: noTools,
			messages: [],
		});
		expect(md).toContain("**Model:** *(unknown)*");
	});

	it("shows tool definitions", () => {
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "",
			tools: [
				{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
				{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } }, promptGuidelines: ["Use bash for shell commands"] },
			],
			messages: [],
		});
		expect(md).toContain("Tools (2)");
		expect(md).toContain("`read`");
		expect(md).toContain("`bash`");
		expect(md).toContain("Read a file");
		expect(md).toContain("Run a command");
		expect(md).toContain("Guidelines:");
	});

	it("shows (none) for empty tools", () => {
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "",
			tools: noTools,
			messages: [],
		});
		expect(md).toContain("Tools (0)");
	});
});

// ── formatResponse ───────────────────────────────────────────

describe("formatResponse", () => {
	it("renders response marker, stop reason, usage, and content", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:34:57.000Z",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
			message: makeAssistant(),
		});

		expect(md).toContain("### ← RESPONSE");
		expect(md).toContain("**Stop reason:** `stop`");
		expect(md).toContain("**Usage:**");
		expect(md).toContain("input: 1,234");
		expect(md).toContain("output: 56");
		expect(md).toContain("total tokens: 1,290");
		expect(md).toContain("$0.0123");
	});

	it("shows error prominently when present", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant({ errorMessage: "rate limit exceeded", stopReason: "error" }),
		});
		expect(md).toContain("**⚠ Error:** rate limit exceeded");
	});

	it("shows response model when it differs from requested", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: { provider: "openrouter", id: "auto", api: "openai-completions" },
			message: makeAssistant({ responseModel: "anthropic/claude-sonnet-4-5" }),
		});
		expect(md).toContain("openrouter/auto");
		expect(md).toContain("response: `anthropic/claude-sonnet-4-5`");
	});

	it("omits response model line when it matches requested", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
			message: makeAssistant(),
		});
		expect(md).not.toContain("response:");
	});

	it("handles empty content", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant({ content: [] }),
		});
		expect(md).toContain("*(no content)*");
	});

	it("shows thinking before text", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant({
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "answer" },
				],
			}),
		});
		expect(md.indexOf("**Thinking:**")).toBeLessThan(md.indexOf("**Text:**"));
	});
});

// ── formatTools ───────────────────────────────────────────────

describe("formatTools", () => {
	it("shows *(none)* for empty tools", () => {
		expect(formatTools([])).toContain("*(none)*");
	});

	it("lists tool names and descriptions", () => {
		const md = formatTools([
			{ name: "read", description: "Read a file", parameters: {} },
			{ name: "bash", description: "Run a command", parameters: {} },
		]);
		expect(md).toContain("Tools (2)");
		expect(md).toContain("`read`");
		expect(md).toContain("Read a file");
		expect(md).toContain("`bash`");
		expect(md).toContain("Run a command");
	});

	it("shows guidelines when present", () => {
		const md = formatTools([
			{ name: "bash", description: "Run a command", parameters: {}, promptGuidelines: ["Use bash for shell commands", "Always check cwd"] },
		]);
		expect(md).toContain("Guidelines:");
		expect(md).toContain("Use bash for shell commands; Always check cwd");
	});

	it("always wraps in details block", () => {
		const md = formatTools([{ name: "read", description: "Read", parameters: { type: "object" } }]);
		expect(md).toContain("<details>");
		expect(md).toContain("</details>");
	});
});

// ── formatProviderPayload ─────────────────────────────────────

describe("formatProviderPayload", () => {
	it("wraps payload in a collapsible details block", () => {
		const md = formatProviderPayload({ model: "claude-sonnet-4-5", messages: [] });
		expect(md).toContain("<details>");
		expect(md).toContain("Raw provider payload");
		expect(md).toContain("```json");
		expect(md).toContain('"model"');
	});

	it("includes char count in summary", () => {
		const md = formatProviderPayload({ short: "hi" });
		expect(md).toContain("chars");
	});
});

// ── formatResponseMeta ─────────────────────────────────────────

describe("formatResponseMeta", () => {
	it("shows HTTP status", () => {
		const md = formatResponseMeta(200, {});
		expect(md).toContain("**HTTP status:** 200");
	});

	it("shows notable headers inline", () => {
		const md = formatResponseMeta(200, { "x-ratelimit-remaining": "100", "content-type": "application/json" });
		expect(md).toContain("`x-ratelimit-remaining`: 100");
	});

	it("collapses many headers into details block", () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i < 10; i++) headers[`x-header-${i}`] = `value-${i}`;
		const md = formatResponseMeta(200, headers);
		expect(md).toContain("<details>");
		expect(md).toContain("Show all headers");
	});
});