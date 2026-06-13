// ============================================================
// Markdown formatters for the LLM log
// ============================================================
// Pure functions that turn structured AgentMessages into a
// human-readable Markdown log. No I/O, no global state.
//
// Design principles:
//   - Everything is present — nothing is removed or truncated
//   - Verbose sections collapse in <details> for scanability
//     in rendered Markdown (GitHub, VS Code, etc.)
//   - Content-first in RESPONSE (what the LLM said, then stats)
//   - One-line summary at top of RESPONSE for quick scanning
//   - Compact tables for usage stats
//
// What collapses:
//   - System prompt (always — long, repeated every turn)
//   - Tool definitions (always — schemas are verbose)
//   - Thinking blocks (always — often thousands of chars)
//   - Tool call arguments (when >300 chars)
//   - Tool results (when >1000 chars)
//   - Raw provider payload (always — huge and mostly redundant)
//   - All HTTP headers (when >5)
//
// What stays visible:
//   - User messages, assistant text, tool call names/ids
//   - One-line RESPONSE summary (model, stop reason, tokens, cost)
//   - Usage table
//   - Notable HTTP headers (rate limits, request ids)

// ── Local type definitions ──────────────────────────────────

export type ModelInfo = { provider: string; id: string; api: string };

interface TextContentBlock { type: "text"; text: string; }
interface ThinkingContentBlock { type: "thinking"; thinking: string; }
interface ImageContentBlock { type: "image"; data: string; mimeType: string; }
interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; }

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
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; };
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FormattableMessage = any;

// ── Thresholds ───────────────────────────────────────────────
const LONG_TOOL_RESULT_CHARS = 1000;
const LONG_ARGS_CHARS = 300;

// ── Helpers ──────────────────────────────────────────────────

function imageBytes(base64: string): number {
	return Math.floor((base64.length * 3) / 4);
}

function fmtNum(n: number): string {
	return n.toLocaleString("en-US");
}

function formatImageBlock(image: ImageContentBlock): string {
	return `*[image: ${image.mimeType}, ${fmtNum(imageBytes(image.data))} bytes]*`;
}

// ── Content block formatters ─────────────────────────────────

function formatThinkingBlock(block: ThinkingContentBlock): string {
	// Always collapse — thinking is often thousands of chars and
	// rarely the primary interest
	return `<details>\n<summary>Thinking (${fmtNum(block.thinking.length)} chars)</summary>\n\n${block.thinking}\n\n</details>`;
}

function formatToolCallBlock(call: ToolCallBlock): string {
	const args = JSON.stringify(call.arguments ?? {}, null, 2);
	// Name and id always visible; args collapse when verbose
	if (args.length <= LONG_ARGS_CHARS) {
		return `**Tool call: \`${call.name}\`** (id: \`${call.id}\`)\n\n\`\`\`json\n${args}\n\`\`\``;
	}
	return `**Tool call: \`${call.name}\`** (id: \`${call.id}\`)\n\n<details>\n<summary>Show arguments (${fmtNum(args.length)} chars)</summary>\n\n\`\`\`json\n${args}\n\`\`\`\n\n</details>`;
}

function formatAssistantContentBlocks(content: AssistantMessage["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "thinking") {
			parts.push(formatThinkingBlock(block));
		} else if (block.type === "toolCall") {
			parts.push(formatToolCallBlock(block));
		}
	}
	return parts.join("\n\n");
}

// ── REQUEST-side formatters ────────────────────────────────────

function toolResultLabel(msg: ToolResultMessage): string {
	const status = msg.isError ? "✗ error" : "✓ success";
	return `Tool result: \`${msg.toolName}\` (id: \`${msg.toolCallId}\`, ${status})`;
}

function formatToolResultBody(msg: ToolResultMessage): string {
	const bodyParts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text") bodyParts.push(block.text);
		else if (block.type === "image") bodyParts.push(formatImageBlock(block));
	}
	return bodyParts.join("\n\n");
}

function formatUserContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return formatImageBlock(block);
			return `*[unknown content: ${(block as { type: string }).type}]*`;
		})
		.join("\n\n");
}

// ── Per-message formatter (REQUEST) ────────────────────────────

export function formatMessage(msg: FormattableMessage, index: number): string {
	const num = `#${index + 1}`;
	if (msg.role === "user") {
		return `**${num} — 👤 User**\n\n${formatUserContent(msg.content)}`;
	}
	if (msg.role === "assistant") {
		const blocks = formatAssistantContentBlocks(msg.content);
		if (!blocks) return `**${num} — 🤖 Assistant** *(empty)*`;
		return `**${num} — 🤖 Assistant**\n\n${blocks}`;
	}
	if (msg.role === "toolResult") {
		const header = `**${num} — 🔧 ${toolResultLabel(msg)}**`;
		const body = formatToolResultBody(msg);
		if (body.length <= LONG_TOOL_RESULT_CHARS) {
			return `${header}\n\n\`\`\`\n${body}\n\`\`\``;
		}
		return `${header} (${fmtNum(body.length)} chars)\n\n<details>\n<summary>Show tool result</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>`;
	}
	const role = (msg as { role: string }).role;
	return `**${num} — 📦 ${role}**\n\n\`\`\`json\n${JSON.stringify(msg, null, 2)}\n\`\`\``;
}

// ── Section formatters ───────────────────────────────────────

function formatModelLine(model: ModelInfo | null, responseModel?: string): string {
	if (!model) return "**Model:** *(unknown)*";
	const requested = `${model.provider}/${model.id}`;
	if (responseModel && responseModel !== model.id) {
		return `**Model:** ${requested} (response: \`${responseModel}\`)`;
	}
	return `**Model:** ${requested}`;
}

function formatSystemPrompt(systemPrompt: string): string {
	// Always collapse — system prompts are long and repeated every turn.
	// The summary line gives enough context at a glance.
	return `<details>\n<summary>System prompt (${fmtNum(systemPrompt.length)} chars)</summary>\n\n\`\`\`\n${systemPrompt}\n\`\`\`\n\n</details>`;
}

function formatUsage(u: AssistantMessage["usage"]): string {
	const lines: string[] = [];
	lines.push("| | tokens |");
	lines.push("|---|---|");
	lines.push(`| input | ${fmtNum(u.input)} |`);
	lines.push(`| output | ${fmtNum(u.output)} |`);
	lines.push(`| cache read | ${fmtNum(u.cacheRead)} |`);
	lines.push(`| cache write | ${fmtNum(u.cacheWrite)} |`);
	lines.push(`| **total** | **${fmtNum(u.totalTokens)}** |`);
	lines.push(`| **cost** | **$${u.cost.total.toFixed(4)}** |`);
	return lines.join("\n");
}

export interface FormatRequestOptions {
	turnIndex: number;
	timestamp: string;
	model: ModelInfo | null;
	systemPrompt: string;
	tools: ToolInfo[];
	messages: FormattableMessage[];
}

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
	httpMeta?: string;
}

export function formatResponse(opts: FormatResponseOptions): string {
	const { timestamp, model, message, httpMeta } = opts;
	const lines: string[] = [];

	// ── One-line summary for quick scanning ──
	lines.push("### ← RESPONSE");
	lines.push("");

	const modelStr = model ? `${model.provider}/${model.id}` : "unknown";
	const costStr = `$${message.usage.cost.total.toFixed(4)}`;
	const stopStr = message.errorMessage ? `⚠ ${message.errorMessage}` : `\`${message.stopReason}\``;
	let summary = `*${timestamp}* · **${modelStr}** · stop: ${stopStr} · ${fmtNum(message.usage.totalTokens)} tokens · ${costStr}`;
	if (message.responseModel && model && message.responseModel !== model.id) {
		summary += ` (actual: \`${message.responseModel}\`)`;
	}
	lines.push(summary);
	lines.push("");

	// ── Content: what the LLM actually said ──
	if (message.errorMessage) {
		lines.push(`> **⚠ Error:** ${message.errorMessage}`);
		lines.push("");
	}

	if (message.content.length === 0) {
		lines.push("*(no content)*");
		lines.push("");
	} else {
		lines.push(formatAssistantContentBlocks(message.content));
		lines.push("");
	}

	// ── Usage stats (always visible, compact table) ──
	lines.push(formatUsage(message.usage));
	lines.push("");

	// ── HTTP metadata ──
	if (httpMeta) {
		lines.push(httpMeta);
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

export interface ToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
}

export function formatTools(tools: ToolInfo[]): string {
	if (tools.length === 0) return "**Tools:** *(none)*\n";

	// Summary line with tool names visible at a glance, full schemas collapsed
	const summary = `**Tools (${tools.length}):** ${tools.map((t) => `\`${t.name}\``).join(", ")}`;
	const entries = tools.map((t) => {
		const desc = t.description || "*(no description)*";
		const params = JSON.stringify(t.parameters ?? {}, null, 2);
		const guidelines = t.promptGuidelines?.length
			? `\n\nGuidelines: ${t.promptGuidelines.join("; ")}`
			: "";
		return `#### \`${t.name}\`\n\n${desc}${guidelines}\n\n\`\`\`json\n${params}\n\`\`\``;
	}).join("\n\n");

	return `${summary}\n\n<details>\n<summary>Show tool definitions</summary>\n\n${entries}\n\n</details>`;
}

// ── Raw provider payload formatter ────────────────────────────

export function formatProviderPayload(payload: unknown): string {
	// Always collapse — huge and mostly redundant with the structured view
	const json = JSON.stringify(payload, null, 2);
	return `<details>\n<summary>Raw provider payload (${fmtNum(json.length)} chars)</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n\n</details>`;
}

// ── HTTP response metadata formatter ──────────────────────────

export function formatResponseMeta(status: number, headers: Record<string, string>): string {
	const lines: string[] = [];
	lines.push(`**HTTP status:** ${status}`);

	const headerKeys = Object.keys(headers);
	if (headerKeys.length > 0) {
		// Notable headers always visible
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

		// All headers — visible if few, collapsed if many
		const allHeaders = headerKeys.map((k) => `\`${k}\`: ${headers[k]}`).join("\n");
		if (headerKeys.length > 5) {
			lines.push("");
			lines.push(`<details>\n<summary>Show all headers (${headerKeys.length})</summary>\n\n${allHeaders}\n\n</details>`);
		} else {
			lines.push("");
			lines.push("**All headers:**");
			lines.push("");
			lines.push("```");
			for (const k of headerKeys) lines.push(`${k}: ${headers[k]}`);
			lines.push("```");
		}
	}

	return lines.join("\n");
}

/** Separator between turns. */
export const TURN_SEPARATOR = "\n---\n\n";