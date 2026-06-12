// ============================================================
// Markdown formatters for the LLM log
// ============================================================
// Pure functions that turn structured AgentMessages into a
// human-readable Markdown log. No I/O, no global state —
// easy to unit test.
//
// Roles are differentiated by the message structure itself:
//   - user         → "👤 User"
//   - assistant    → "🤖 Assistant"
//   - toolResult   → "🔧 Tool result: <name> (id, status)"
//   - other custom → "📦 <role>"
//
// Input vs output is differentiated by the caller (index.ts):
// input is the full request (system + messages from `context`),
// output is the final assistant response (from `message_end`).
//
// Content blocks are differentiated by their `type` field:
//   - text     → plain text
//   - thinking → italicized
//   - image    → "[image: mime, N bytes]" (no base64 dump)
//   - toolCall → code block with JSON arguments
// ============================================================

// ── Local type definitions ──────────────────────────────────
// These mirror the runtime shapes from @earendil-works/pi-ai.
// We can't import them directly (pi-ai is a transitive dep), so
// we declare the minimum surface area the formatters need.

export type ModelInfo = { provider: string; id: string; api: string };

interface TextContentBlock {
	type: "text";
	text: string;
}

interface ThinkingContentBlock {
	type: "thinking";
	thinking: string;
}

interface ImageContentBlock {
	type: "image";
	data: string;
	mimeType: string;
}

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type AssistantMessage = {
	role: "assistant";
	content: (TextContentBlock | ThinkingContentBlock | ToolCallBlock)[];
	provider: string;
	model: string;
	api: string;
	responseModel?: string;
	stopReason: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
	errorMessage?: string;
};

export type ToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContentBlock | ImageContentBlock)[];
	isError: boolean;
};

export type UserMessage = {
	role: "user";
	content: string | (TextContentBlock | ImageContentBlock)[];
	timestamp: number;
};

/**
 * Anything the formatter can accept. We use `any` so the runtime
 * AgentMessage union (which includes custom message types from
 * pi-coding-agent) is structurally assignable without us having
 * to re-declare the entire union here. The formatters handle
 * each role via runtime `role` checks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FormattableMessage = any;

// ── Thresholds ───────────────────────────────────────────────
const LONG_SYSTEM_PROMPT_CHARS = 500;
const LONG_TOOL_RESULT_CHARS = 1000;
const LONG_THINKING_CHARS = 2000;

// ── Helpers ──────────────────────────────────────────────────

function imageBytes(base64: string): number {
	// base64 length * 3/4 ≈ decoded bytes (with padding adjustment)
	return Math.floor((base64.length * 3) / 4);
}

/** Format a number with thousands separators. */
function fmtNum(n: number): string {
	return n.toLocaleString("en-US");
}

// ── Content block formatters ─────────────────────────────────

function formatImageBlock(image: ImageContentBlock): string {
	return `*[image: ${image.mimeType}, ${fmtNum(imageBytes(image.data))} bytes]*`;
}

function formatThinkingInline(thinking: string): string {
	if (thinking.length <= LONG_THINKING_CHARS) {
		return thinking;
	}
	const truncated = thinking.slice(0, LONG_THINKING_CHARS);
	return `${truncated}\n\n*[truncated — ${fmtNum(thinking.length - LONG_THINKING_CHARS)} more chars]*`;
}

function formatToolCallBlock(call: ToolCallBlock): string {
	const args = JSON.stringify(call.arguments ?? {}, null, 2);
	return `**Tool call: \`${call.name}\`** (id: \`${call.id}\`)\n\n\`\`\`json\n${args}\n\`\`\``;
}

function formatAssistantContentBlocks(content: AssistantMessage["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(`**Text:**\n\n${block.text}`);
		} else if (block.type === "thinking") {
			parts.push(`**Thinking:**\n\n${formatThinkingInline(block.thinking)}`);
		} else if (block.type === "toolCall") {
			parts.push(formatToolCallBlock(block));
		}
	}
	return parts.join("\n\n");
}

/** Returns just the "Tool result: `name` (id, status)" label, without markdown bold. */
function toolResultLabel(msg: ToolResultMessage): string {
	const status = msg.isError ? "✗ error" : "✓ success";
	return `Tool result: \`${msg.toolName}\` (id: \`${msg.toolCallId}\`, ${status})`;
}

function formatToolResultBody(msg: ToolResultMessage): string {
	const bodyParts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text") {
			bodyParts.push(block.text);
		} else if (block.type === "image") {
			bodyParts.push(formatImageBlock(block));
		}
	}
	return bodyParts.join("\n\n");
}


function formatUserContent(content: UserMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return formatImageBlock(block);
			return `*[unknown content: ${(block as { type: string }).type}]*`;
		})
		.join("\n\n");
}

// ── Per-message formatter ────────────────────────────────────

/**
 * Format a single message with role label and content.
 * Used for messages inside a REQUEST (input to the LLM).
 */
export function formatMessage(msg: FormattableMessage, index: number): string {
	const num = `#${index + 1}`;
	if (msg.role === "user") {
		return `**${num} — 👤 User**\n\n${formatUserContent(msg.content)}`;
	}
	if (msg.role === "assistant") {
		const blocks = formatAssistantContentBlocks(msg.content);
		if (!blocks) {
			return `**${num} — 🤖 Assistant** *(empty)*`;
		}
		return `**${num} — 🤖 Assistant**\n\n${blocks}`;
	}
	if (msg.role === "toolResult") {
		const header = `**${num} — 🔧 ${toolResultLabel(msg)}**`;
		const body = formatToolResultBody(msg);
		if (body.length <= LONG_TOOL_RESULT_CHARS) {
			return `${header}\n\n\`\`\`\n${body}\n\`\`\``;
		}
		return `${header} — ${fmtNum(body.length)} chars\n\n<details>\n<summary>Show tool result</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>`;
	}
	// Custom messages (bashExecution, custom, branchSummary, compactionSummary)
	const role = (msg as { role: string }).role;
	return `**${num} — 📦 ${role}**\n\n\`\`\`json\n${JSON.stringify(msg, null, 2)}\n\`\`\``;
}

// ── Section formatters ───────────────────────────────────────

function formatModelLine(model: ModelInfo | null, responseModel?: string): string {
	if (!model) {
		return "**Model:** *(unknown)*";
	}
	const requested = `${model.provider}/${model.id}`;
	if (responseModel && responseModel !== model.id) {
		return `**Model:** ${requested} (response: \`${responseModel}\`)`;
	}
	return `**Model:** ${requested}`;
}

function formatSystemPrompt(systemPrompt: string): string {
	if (systemPrompt.length <= LONG_SYSTEM_PROMPT_CHARS) {
		return `**System prompt:**\n\n\`\`\`\n${systemPrompt}\n\`\`\``;
	}
	return `**System prompt:** ${fmtNum(systemPrompt.length)} chars\n\n<details>\n<summary>Show system prompt</summary>\n\n\`\`\`\n${systemPrompt}\n\`\`\`\n\n</details>`;
}

export interface FormatRequestOptions {
	turnIndex: number;
	timestamp: string;
	model: ModelInfo | null;
	systemPrompt: string;
	tools: ToolInfo[];
	messages: FormattableMessage[];
}

/**
 * Format a REQUEST section — what was sent to the LLM.
 * Includes the system prompt, active tools, and all messages in the context.
 */
export function formatRequest(opts: FormatRequestOptions): string {
	const { turnIndex, timestamp, model, systemPrompt, tools, messages } = opts;
	const lines: string[] = [];

	lines.push(`## Turn ${turnIndex} — ${timestamp}`);
	lines.push("");
	lines.push("### → REQUEST");
	lines.push("");
	lines.push(formatModelLine(model));
	lines.push("");
	lines.push(formatSystemPrompt(systemPrompt));
	lines.push("");

	// Tools — always collapsible since schemas are verbose
	lines.push(formatTools(tools));
	lines.push("");

	lines.push(`**Messages (${messages.length}):**`);
	lines.push("");

	if (messages.length === 0) {
		lines.push("*(no messages)*");
	} else {
		messages.forEach((m, i) => {
			lines.push(formatMessage(m, i));
			lines.push("");
		});
	}

	return lines.join("\n");
}

export interface FormatResponseOptions {
	timestamp: string;
	model: ModelInfo | null;
	message: AssistantMessage;
}

/**
 * Format a RESPONSE section — what came back from the LLM.
 * Includes content blocks (text / thinking / tool calls) and usage.
 */
export function formatResponse(opts: FormatResponseOptions): string {
	const { timestamp, model, message } = opts;
	const lines: string[] = [];

	lines.push("### ← RESPONSE");
	lines.push("");
	lines.push(`*${timestamp}*`);
	lines.push("");
	lines.push(formatModelLine(model, message.responseModel));
	lines.push("");

	// Error (if any) — show prominently
	if (message.errorMessage) {
		lines.push(`> **⚠ Error:** ${message.errorMessage}`);
		lines.push("");
	}

	// Stop reason
	lines.push(`**Stop reason:** \`${message.stopReason}\``);
	lines.push("");

	// Usage
	const u = message.usage;
	lines.push("**Usage:**");
	lines.push(`- input: ${fmtNum(u.input)}`);
	lines.push(`- output: ${fmtNum(u.output)}`);
	lines.push(`- cache read: ${fmtNum(u.cacheRead)}`);
	lines.push(`- cache write: ${fmtNum(u.cacheWrite)}`);
	lines.push(`- total tokens: ${fmtNum(u.totalTokens)}`);
	lines.push(`- cost: $${u.cost.total.toFixed(4)}`);
	lines.push("");

	// Content blocks
	if (message.content.length === 0) {
		lines.push("*(no content)*");
	} else {
		lines.push(formatAssistantContentBlocks(message.content));
		lines.push("");
	}

	return lines.join("\n");
}

export interface FormatSessionHeaderOptions {
	sessionFile: string | null;
	sessionId: string;
	model: ModelInfo | null;
	startedAt: string;
}

/**
 * Format the file header — written once at the top of the log.
 */
export function formatSessionHeader(opts: FormatSessionHeaderOptions): string {
	const { sessionFile, sessionId, model, startedAt } = opts;
	const lines: string[] = [];

	lines.push("# LLM Log");
	lines.push("");
	lines.push(`**Session ID:** \`${sessionId}\``);
	if (sessionFile) {
		lines.push(`**Session file:** \`${sessionFile}\``);
	} else {
		lines.push("**Session file:** *(ephemeral)*");
	}
	if (model) {
		lines.push(`**Initial model:** ${model.provider}/${model.id}`);
	}
	lines.push(`**Started:** ${startedAt}`);
	lines.push("");
	lines.push("---");
	lines.push("");

	return lines.join("\n");
}

// ── Tool definitions formatter ─────────────────────────────────

/** Shape of a single tool returned by pi.getActiveTools(). */
export interface ToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
}

/**
 * Format the active tool definitions as a collapsible section.
 * Shows tool name, description, and JSON Schema for parameters.
 */
export function formatTools(tools: ToolInfo[]): string {
	if (tools.length === 0) return "**Tools:** *(none)*";

	const summary = `**Tools (${tools.length}):**`;
	const entries = tools.map((t) => {
		const desc = t.description || "*(no description)*";
		const params = JSON.stringify(t.parameters ?? {}, null, 2);
		const guidelines = t.promptGuidelines?.length
			? `\n\nGuidelines: ${t.promptGuidelines.join("; ")}`
			: "";
		return `#### \`${t.name}\`\n\n${desc}${guidelines}\n\n\`\`\`json\n${params}\n\`\`\``;
	}).join("\n\n");

	// Always collapsible — tool schemas are verbose
	return `${summary}\n\n<details>\n<summary>Show tool definitions</summary>\n\n${entries}\n\n</details>`;
}

// ── Raw provider payload formatter ────────────────────────────

/**
 * Format the raw provider payload as a collapsible JSON block.
 * This is the exact bytes sent to the LLM endpoint, in the
 * provider's native format (Anthropic / OpenAI / Google / etc.).
 */
export function formatProviderPayload(payload: unknown): string {
	const json = JSON.stringify(payload, null, 2);
	// Always collapsible — payloads are large and mostly redundant
	// with the structured view above
	return `<details>\n<summary>Raw provider payload (${fmtNum(json.length)} chars)</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n\n</details>`;
}

// ── HTTP response metadata formatter ──────────────────────────

/**
 * Format HTTP response metadata (status code and headers).
 */
export function formatResponseMeta(status: number, headers: Record<string, string>): string {
	const lines: string[] = [];
	lines.push(`**HTTP status:** ${status}`);

	const headerKeys = Object.keys(headers);
	if (headerKeys.length > 0) {
		// Show notable headers inline
		const notable = headerKeys
			.filter((k) =>
				k.toLowerCase().startsWith("x-ratelimit") ||
				k.toLowerCase().startsWith("retry") ||
				k.toLowerCase().includes("request-id") ||
				k.toLowerCase().includes("trace"),
			)
			.map((k) => `\`${k}\`: ${headers[k]}`);

		if (notable.length > 0) {
			lines.push("");
			lines.push("**Notable headers:**");
			for (const h of notable) lines.push(`- ${h}`);
		}

		// All headers in a collapsible block
		const allHeaders = headerKeys.map((k) => `\`${k}\`: ${headers[k]}`).join("\n");
		if (headerKeys.length > 5) {
			lines.push("");
			lines.push(`<details>\n<summary>Show all headers (${headerKeys.length})</summary>\n\n${allHeaders}\n\n</details>`);
		}
	}

	return lines.join("\n");
}

/** Separator between turns. */
export const TURN_SEPARATOR = "\n---\n\n";
