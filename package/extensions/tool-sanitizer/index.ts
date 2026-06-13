// ============================================================
// tool-sanitizer — Pre-tool-call JSON argument sanitizer
// ============================================================
// Intercepts every tool call via the tool_call event and
// sanitizes malformed arguments before execution.
//
// Repairs:
//   - Top-level JSON strings parsed into objects
//   - Invalid entries in object arrays dropped (e.g. stray
//     strings, nulls, booleans inside a list of objects)
//   - Invalid object properties removed or repaired
//   - Stringified JSON values parsed when the schema expects
//     objects or arrays
//   - Simple type coercions (number → string etc.)
//
// Enable/disable:
//   /tool-sanitizer:enable   — activate sanitizer
//   /tool-sanitizer:disable  — deactivate sanitizer
//   /tool-sanitizer:log      — show recent sanitization log
//
// The sanitizer is DISABLED by default.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sanitizeToolInput, type SanitizeResult } from "./sanitize";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── State persistence ────────────────────────────────────────

interface SanitizerState {
	enabled: boolean;
}

const STATE_FILE = join(getAgentDir(), "tool-sanitizer.json");

function loadState(): SanitizerState {
	try {
		if (existsSync(STATE_FILE)) {
			const raw = readFileSync(STATE_FILE, "utf-8");
			const parsed = JSON.parse(raw);
			if (typeof parsed.enabled === "boolean") {
				return { enabled: parsed.enabled };
			}
		}
	} catch {
		// Ignore read/parse errors — use default
	}
	return { enabled: false }; // Disabled by default
}

function saveState(state: SanitizerState): void {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
	} catch {
		// Ignore write errors
	}
}

// ── Repair log (in-memory, recent entries only) ──────────────

interface LogEntry {
	timestamp: number;
	toolName: string;
	repairs: string[];
}

const MAX_LOG_ENTRIES = 100;
const repairLog: LogEntry[] = [];

function appendLog(toolName: string, repairs: string[]): void {
	repairLog.push({ timestamp: Date.now(), toolName, repairs });
	if (repairLog.length > MAX_LOG_ENTRIES) {
		repairLog.splice(0, repairLog.length - MAX_LOG_ENTRIES);
	}
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let state = loadState();

	// ── Commands ───────────────────────────────────────────
	pi.registerCommand("tool-sanitizer:enable", {
		description: "Enable the tool argument sanitizer",
		handler: async (_args, ctx) => {
			state.enabled = true;
			saveState(state);
			ctx.ui.notify("Tool sanitizer enabled", "info");
		},
	});

	pi.registerCommand("tool-sanitizer:disable", {
		description: "Disable the tool argument sanitizer",
		handler: async (_args, ctx) => {
			state.enabled = false;
			saveState(state);
			ctx.ui.notify("Tool sanitizer disabled", "info");
		},
	});

	pi.registerCommand("tool-sanitizer:log", {
		description: "Show recent tool sanitizer repairs",
		handler: async (_args, ctx) => {
			if (repairLog.length === 0) {
				ctx.ui.notify("No sanitization repairs recorded yet.", "info");
				return;
			}

			const lines = repairLog.map((entry) => {
				const time = new Date(entry.timestamp).toLocaleTimeString();
				return `[${time}] ${entry.toolName}: ${entry.repairs.join("; ")}`;
			});

			ctx.ui.notify(`Sanitizer log (${repairLog.length} entries):\n${lines.join("\n")}`, "info");
		},
	});

	// ── Hook: tool_call ────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return undefined;

		// Look up the tool definition for its parameter schema
		const tools = pi.getAllTools();
		const tool = tools.find((t) => t.name === event.toolName);
		const schema = tool?.parameters;

		const result: SanitizeResult = sanitizeToolInput(
			event.input,
			schema as any, // eslint-disable-line @typescript-eslint/no-explicit-any
			event.toolName,
		);

		if (result.changed && result.repairs.length > 0) {
			// Mutate event.input in place — this is the tool_call hook contract.
			// Clear existing keys first so removed properties are also dropped.
			if (typeof result.value === "object" && result.value !== null && !Array.isArray(result.value)) {
				for (const key of Object.keys(event.input)) {
					if (!(key in (result.value as Record<string, unknown>))) {
						delete (event.input as Record<string, unknown>)[key];
					}
				}
				Object.assign(event.input, result.value);
			}

			// Log and notify
			appendLog(event.toolName, result.repairs);

			const summary = result.repairs.join("; ");
			ctx.ui.notify(
				`🔧 Tool sanitizer repaired ${event.toolName}: ${summary}`,
				"info",
			);
		}

		return undefined; // Never block
	});
}