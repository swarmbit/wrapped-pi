// ============================================================
// llm-log — Log all text exchanged with the LLM endpoint
// ============================================================
// Produces a human-readable Markdown log of every LLM exchange.
// Disabled by default; use /llmlog to toggle or /llmlog on|off.
//
// Everything is present in the log — nothing is removed or
// truncated. Verbose sections (system prompts, tool schemas,
// thinking blocks, raw payloads) collapse in <details> blocks
// so the file remains scannable in rendered Markdown.
//
// Structure per turn:
//   ## Turn N — <timestamp>
//   ### → REQUEST   (system prompt, tools, messages, raw payload)
//   ### ← RESPONSE  (summary line, content, usage, HTTP meta)
//
// Log file: <session-dir>/llm-log-<session-id>.md for sessions,
//           ~/.pi/agent/logs/llm-log-<timestamp>.md for ephemeral.
// ============================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatRequest,
	formatResponse,
	formatSessionHeader,
	formatProviderPayload,
	formatResponseMeta,
	TURN_SEPARATOR,
	type ModelInfo,
	type ToolInfo,
} from "./format.js";

const GLOBAL_LOG_DIR = path.join(os.homedir(), ".pi", "agent", "logs");

// ── File I/O helpers ────────────────────────────────────────

function ensureDir(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendToFile(filePath: string, content: string): void {
	ensureDir(filePath);
	fs.appendFileSync(filePath, content, "utf8");
}

function writeIfMissing(filePath: string, content: string): void {
	// Write only if the file doesn't exist or is empty (preserves prior content
	// on session resume).
	if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
		appendToFile(filePath, content);
	}
}

// ── Path / id helpers ───────────────────────────────────────

function getLogFilePath(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionId = getSessionId(sessionFile);
		// One log per session, sitting next to the session .jsonl file.
		return path.join(path.dirname(sessionFile), `llm-log-${sessionId}.md`);
	}
	// Ephemeral: use a timestamped file in the global log dir
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(GLOBAL_LOG_DIR, `llm-log-${ts}.md`);
}

function getSessionId(sessionFile: string | null): string {
	if (!sessionFile) return "ephemeral";
	// session file is named <session-id>.jsonl
	return path.basename(sessionFile, ".jsonl");
}

// Minimal shape of what `ctx.model` exposes. We don't import the full Model
// type from pi-ai (it's a transitive dep) — we just read the three fields
// we care about for logging.
interface ModelLike {
	provider: string;
	id: string;
	api: string;
}

function modelInfo(model: ModelLike | undefined): ModelInfo | null {
	if (!model) return null;
	return { provider: model.provider, id: model.id, api: model.api };
}

// ── Extension ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Logging is DISABLED by default. The user must run /llmlog (or /llmlog on)
	// to start capturing.
	let enabled = false;

	// Per-session state (set during session_start, cleared on shutdown)
	let logFile: string | null = null;
	let currentTurnIndex = 0;

	// Tracks which turn we last logged a request for. Used to pair a response
	// back to its request, and to filter out historical assistant messages
	// loaded from a restored session.
	let lastRequestTurnIndex: number | null = null;

	// HTTP response metadata from `after_provider_response` is buffered here
	// and appended to the RESPONSE section when `message_end` fires. This
	// keeps the log order natural: REQUEST, raw payload, RESPONSE (+ HTTP meta).
	let pendingHttpMeta: string | null = null;

	// ── /llmlog command ─────────────────────────────────────
	//
	// Usage:
	//   /llmlog        — toggle logging on/off
	//   /llmlog on     — enable logging
	//   /llmlog off    — disable logging
	//   /llmlog status — show current state and log file path
	//
	pi.registerCommand("llmlog", {
		description: "Toggle or check LLM logging (on/off/status)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "on") {
				enabled = true;
			} else if (arg === "off") {
				enabled = false;
			} else if (arg === "status") {
				// Show status without toggling
			} else {
				// Toggle
				enabled = !enabled;
			}

			const state = enabled ? "✅ ON" : "⛔ OFF";
			ctx.ui.notify(`LLM logging: ${state}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		logFile = getLogFilePath(sessionFile);
		const sessionId = getSessionId(sessionFile);

		// Even if logging is disabled, we initialise the log file path so
		// the /llmlog command can always show where the file would be.
		// The header is written lazily the first time logging is enabled.
		// (On resume, if the file already exists we don't overwrite it.)
		if (enabled) {
			const header = formatSessionHeader({
				sessionFile,
				sessionId,
				model: modelInfo(ctx.model),
				startedAt: new Date().toISOString(),
			});
			writeIfMissing(logFile, header);
		}

		currentTurnIndex = 0;
		lastRequestTurnIndex = null;
		pendingHttpMeta = null;
	});

	pi.on("turn_start", (event) => {
		currentTurnIndex = event.turnIndex;
		pendingHttpMeta = null;
	});

	// Helper: lazily write the session header the first time logging is
	// enabled for a session. Safe to call multiple times — it uses
	// writeIfMissing.
	function ensureHeader(ctx: { sessionManager: { getSessionFile: () => string | undefined }; model: ModelLike | undefined }) {
		if (!logFile) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const sessionId = getSessionId(sessionFile);
		const header = formatSessionHeader({
			sessionFile,
			sessionId,
			model: modelInfo(ctx.model),
			startedAt: new Date().toISOString(),
		});
		writeIfMissing(logFile, header);
	}

	// ── INPUT: log the request sent to the LLM ──────────────
	//
	// `context` carries the complete messages array that pi is about to send.
	// This is the most reliable, provider-agnostic source of "what was sent":
	// it has already been through the `context` event chain (and any
	// context-event extensions), but hasn't been serialized to a provider-
	// specific payload yet.
	//
	// We pair this with `ctx.getSystemPrompt()` for the system prompt and
	// `pi.getActiveTools()` for the tool definitions that accompany the request.
	pi.on("context", (event, ctx) => {
		if (!enabled) return;
		if (!logFile) return;

		ensureHeader(ctx);

		const activeToolNames = new Set(pi.getActiveTools());
		const allTools: ToolInfo[] = pi.getAllTools()
			.filter((t) => activeToolNames.has(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
				promptGuidelines: t.promptGuidelines,
			}));

		const request = formatRequest({
			turnIndex: currentTurnIndex,
			timestamp: new Date().toISOString(),
			model: modelInfo(ctx.model),
			systemPrompt: ctx.getSystemPrompt(),
			tools: allTools,
			messages: event.messages,
		});

		appendToFile(logFile, request + "\n\n");
		lastRequestTurnIndex = currentTurnIndex;
	});

	// ── OUTPUT: log the response from the LLM ───────────────
	//
	// We log the finalized assistant message from `message_end`. This fires
	// once per assistant turn, after streaming completes.
	//
	// Guards:
	//   - Logging must be enabled
	//   - Only assistant messages (the LLM's role)
	//   - Only when we logged a request for this turn. This filters out
	//     historical assistant messages loaded from a restored session (they
	//     fire message_end outside any active request/response pair).
	pi.on("message_end", (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;
		if (!logFile) return;
		// Only log responses for turns where we logged the request. This
		// filters out historical assistant messages loaded from a restored
		// session (they fire outside any active request/response pair).
		if (lastRequestTurnIndex !== currentTurnIndex) return;

		const response = formatResponse({
			timestamp: new Date().toISOString(),
			model: modelInfo(ctx.model),
			message: event.message,
			httpMeta: pendingHttpMeta ?? undefined,
		});

		pendingHttpMeta = null;
		appendToFile(logFile, response + "\n" + TURN_SEPARATOR);
	});

	// ── RAW PAYLOAD: log the exact provider-specific payload ───
	//
	// `before_provider_request` fires after `context` and gives us the
	// final provider-specific payload (Anthropic / OpenAI / Google etc.).
	// This is the exact bytes that go on the wire. Logged as a collapsible
	// JSON block so it doesn't overwhelm the structured view above.
	pi.on("before_provider_request", (event) => {
		if (!enabled) return;
		if (!logFile) return;

		const payload = formatProviderPayload(event.payload);
		appendToFile(logFile, payload + "\n\n");
	});

	// ── HTTP RESPONSE METADATA ──────────────────────────────────
	//
	// `after_provider_response` gives us the HTTP status and response
	// headers. Useful for debugging rate limits, request IDs, etc.
	pi.on("after_provider_response", (event) => {
		if (!enabled) return;
		if (!logFile) return;

		// Buffer the metadata so it can be appended to the RESPONSE section
		// when `message_end` fires. This keeps the log reading order natural.
		pendingHttpMeta = formatResponseMeta(event.status, event.headers);
	});
}