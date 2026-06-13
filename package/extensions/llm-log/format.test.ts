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

// ── formatMessage — role differentiation ────────────────────

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
		expect(md).toContain("world");
	});

	it("collapses thinking into details block with char count", () => {
		const md = formatMessage(
			makeAssistant({ content: [{ type: "thinking", thinking: "let me think..." }] }),
			0,
		);
		expect(md).toContain("<details>");
		expect(md).toContain("Thinking");
		expect(md).toContain("chars</summary>");
		expect(md).toContain("let me think...");
	});

	it("shows tool call name and id visible, args collapse when long", () => {
		const bigArgs: Record<string, unknown> = {};
		for (let i = 0; i < 50; i++) bigArgs[`key_${i}`] = "x".repeat(20);
		const md = formatMessage(
			makeAssistant({
				content: [
					{ type: "toolCall", id: "toolu_xyz", name: "bash", arguments: bigArgs },
				],
			}),
			0,
		);
		expect(md).toContain("Tool call: `bash`");
		expect(md).toContain("`toolu_xyz`");
		// Long args collapse into details
		expect(md).toContain("<details>");
		expect(md).toContain("Show arguments");
	});

	it("shows short tool call args inline", () => {
		const md = formatMessage(
			makeAssistant({
				content: [
					{ type: "toolCall", id: "toolu_xyz", name: "bash", arguments: { command: "ls" } },
				],
			}),
			0,
		);
		expect(md).toContain("Tool call: `bash`");
		expect(md).toContain('"command": "ls"');
		// Short args not collapsed
		expect(md).not.toContain("Show arguments");
	});

	it("does NOT dump base64 for image blocks", () => {
		const fakeBase64 = "A".repeat(100);
		const md = formatMessage(
			makeUser([{ type: "image", data: fakeBase64, mimeType: "image/png" }]),
			0,
		);
		expect(md).not.toContain("A".repeat(50));
		expect(md).toContain("[image: image/png");
		expect(md).toContain("bytes]");
	});

	it("collapses long tool results into <details>", () => {
		const longContent = "x".repeat(2000);
		const md = formatMessage(makeToolResult({ content: [{ type: "text", text: longContent }] }), 0);
		expect(md).toContain("<details>");
		expect(md).toContain("Show tool result");
		expect(md).toContain("2,000 chars");
	});

	it("shows short tool results inline", () => {
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

	it("always collapses system prompt into details", () => {
		const short = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "short",
			tools: [],
			messages: [],
		});
		expect(short).toContain("<details>");
		expect(short).toContain("System prompt");
		expect(short).toContain("chars");

		const long = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "x".repeat(5000),
			tools: [],
			messages: [],
		});
		expect(long).toContain("<details>");
		expect(long).toContain("5,000 chars");
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

	it("shows tool names in summary line and definitions in details", () => {
		const md = formatRequest({
			turnIndex: 0,
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			systemPrompt: "",
			tools: [
				{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
				{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
			],
			messages: [],
		});
		// Summary line visible
		expect(md).toContain("Tools (2)");
		expect(md).toContain("`read`");
		expect(md).toContain("`bash`");
		// Definitions collapsed
		expect(md).toContain("<summary>Show tool definitions</summary>");
		expect(md).toContain("Read a file");
		expect(md).toContain("Run a command");
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
		expect(md).toContain("*(none)*");
	});
});

// ── formatResponse ───────────────────────────────────────────

describe("formatResponse", () => {
	it("renders response with one-line summary and content first", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:34:57.000Z",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
			message: makeAssistant(),
		});

		expect(md).toContain("### ← RESPONSE");
		expect(md).toContain("anthropic/claude-sonnet-4-5");
		expect(md).toContain("stop: `stop`");
		expect(md).toContain("$0.0123");
		expect(md).toContain("1,290 tokens");
		expect(md).toContain("Hello!");
		// Content comes before usage
		expect(md.indexOf("Hello!")).toBeLessThan(md.indexOf("| input |"));
	});

	it("shows error in summary and blockquote", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant({ errorMessage: "rate limit exceeded", stopReason: "error" }),
		});
		expect(md).toContain("⚠ rate limit exceeded");
		expect(md).toContain("> **⚠ Error:** rate limit exceeded");
	});

	it("shows response model when it differs from requested", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: { provider: "openrouter", id: "auto", api: "openai-completions" },
			message: makeAssistant({ responseModel: "anthropic/claude-sonnet-4-5" }),
		});
		expect(md).toContain("actual: `anthropic/claude-sonnet-4-5`");
	});

	it("renders usage as a table", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
			message: makeAssistant(),
		});
		expect(md).toContain("| input |");
		expect(md).toContain("| output |");
		expect(md).toContain("| **total** |");
		expect(md).toContain("| **cost** |");
		expect(md).toContain("1,234");
		expect(md).toContain("56");
	});

	it("handles empty content", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant({ content: [] }),
		});
		expect(md).toContain("*(no content)*");
	});

	it("shows thinking in details block with char count", () => {
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
		expect(md).toContain("<details>");
		expect(md).toContain("Thinking");
		expect(md).toContain("hmm");
		expect(md).toContain("answer");
	});

	it("shows tool call with collapsed args when long", () => {
		const bigArgs: Record<string, unknown> = {};
		for (let i = 0; i < 50; i++) bigArgs[`key_${i}`] = "x".repeat(20);
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant({
				content: [
					{ type: "toolCall", id: "toolu_abc", name: "bash", arguments: bigArgs },
				],
			}),
		});
		expect(md).toContain("Tool call: `bash`");
		expect(md).toContain("<summary>Show arguments");
	});

	it("appends HTTP metadata after usage", () => {
		const md = formatResponse({
			timestamp: "2026-06-12T12:00:00.000Z",
			model: null,
			message: makeAssistant(),
			httpMeta: "**HTTP status:** 200\n\n**Notable headers:**\n- `x-req`: abc",
		});
		expect(md).toContain("**HTTP status:** 200");
		expect(md).toContain("`x-req`: abc");
		// Usage before HTTP meta
		expect(md.indexOf("| **cost** |")).toBeLessThan(md.indexOf("**HTTP status:** 200"));
	});
});

// ── formatTools ───────────────────────────────────────────────

describe("formatTools", () => {
	it("shows *(none)* for empty tools", () => {
		expect(formatTools([])).toContain("*(none)*");
	});

	it("shows tool names in summary and full definitions in details", () => {
		const md = formatTools([
			{ name: "read", description: "Read a file", parameters: {} },
			{ name: "bash", description: "Run a command", parameters: {} },
		]);
		expect(md).toContain("Tools (2)");
		expect(md).toContain("`read`");
		expect(md).toContain("Read a file");
		expect(md).toContain("`bash`");
		expect(md).toContain("Run a command");
		expect(md).toContain("<details>");
	});

	it("shows guidelines when present", () => {
		const md = formatTools([
			{ name: "bash", description: "Run a command", parameters: {}, promptGuidelines: ["Use bash for shell commands", "Always check cwd"] },
		]);
		expect(md).toContain("Guidelines:");
		expect(md).toContain("Use bash for shell commands; Always check cwd");
	});

	it("always wraps tool definitions in details block", () => {
		const md = formatTools([{ name: "read", description: "Read", parameters: { type: "object" } }]);
		expect(md).toContain("<details>");
		expect(md).toContain("</details>");
		expect(md).toContain("<summary>Show tool definitions</summary>");
	});
});

// ── formatProviderPayload ─────────────────────────────────────

describe("formatProviderPayload", () => {
	it("wraps payload in details block with char count", () => {
		const md = formatProviderPayload({ model: "claude-sonnet-4-5", messages: [] });
		expect(md).toContain("<details>");
		expect(md).toContain("Raw provider payload");
		expect(md).toContain("chars");
		expect(md).toContain("```json");
		expect(md).toContain('"model"');
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

	it("shows few headers inline in code block", () => {
		const md = formatResponseMeta(200, { "content-type": "application/json" });
		expect(md).toContain("**All headers:**");
		expect(md).toContain("content-type: application/json");
		expect(md).not.toContain("<details>");
	});
});