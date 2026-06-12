// ============================================================
// llm-log — Log all text exchanged with the LLM endpoint
// ============================================================
// Produces a human-readable Markdown log of every LLM exchange.
// Disabled by default; use /llmlog to toggle or /llmlog on|off.
//
// Differentiation approach (why this works):
//   ┌──────────────────────────────────────────────────────┐
//   │  Input vs output is differentiated by EVENT:         │
//   │    • `context`      → fires with the full messages   │
//   │                       array that pi is about to send  │
//   │                       to the LLM (this is INPUT)     │
//   │    • `message_end`  → fires for assistant messages   │
//   │                       when the LLM response is       │
//   │                       finalized (this is OUTPUT)     │
//   │                                                      │
//   │  Role is intrinsic to each AgentMessage:             │
//   │    • "user"        → 👤 User                         │
//   │    • "assistant"   → 🤖 Assistant                    │
//   │    • "toolResult"  → 🔧 Tool result                  │
//   │    • custom types  → 📦 <role>                       │
//   │                                                      │
//   │  Content blocks have typed subtypes:                 │
//   │    • type: "text"      → plain text                  │
//   │    • type: "thinking"  → italicized thinking         │
//   │    • type: "image"     → "[image: mime, N bytes]"    │
//   │    • type: "toolCall"  → code block with JSON args   │
//   │                                                      │
//   │  System prompt is captured via `ctx.getSystemPrompt()`│
//   │  at the time of the LLM call.                        │
//   └──────────────────────────────────────────────────────┘
//
// Log file: <session-dir>/llm-log.md for sessions,
//           ~/.pi/agent/logs/llm-log-<timestamp>.md for ephemeral.
//
// Long system prompts and tool results go in <details> blocks
// so the file remains scannable.
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
		// Log sits next to the session file. Findable, per-session, easy to clean up.
		return path.join(path.dirname(sessionFile), "llm-log.md");
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
	let turnInProgress = false;

	// Tracks which turn we last logged a request for. Used to pair a response
	// back to its request, and to filter out historical assistant messages
	// loaded from a restored session.
	let lastRequestTurnIndex: number | null = null;

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
			const pathInfo = logFile ? `\nLog file: ${logFile}` : "\nNo session active yet";
			ctx.ui.notify(`LLM logging: ${state}${pathInfo}`, "info");
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
		turnInProgress = false;
		lastRequestTurnIndex = null;
	});

	pi.on("turn_start", (event) => {
		currentTurnIndex = event.turnIndex;
		turnInProgress = true;
	});

	pi.on("turn_end", () => {
		turnInProgress = false;
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
	//   - Only when an active turn is in progress, OR a request was logged
	//     for this turn. This filters historical assistant messages loaded
	//     from a restored session (they fire message_end outside any turn).
	pi.on("message_end", (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;
		if (!logFile) return;
		if (!turnInProgress && lastRequestTurnIndex !== currentTurnIndex) return;
		if (lastRequestTurnIndex !== currentTurnIndex) return;

		const response = formatResponse({
			timestamp: new Date().toISOString(),
			model: modelInfo(ctx.model),
			message: event.message,
		});

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

		const meta = formatResponseMeta(event.status, event.headers);
		appendToFile(logFile, meta + "\n\n");
	});
}