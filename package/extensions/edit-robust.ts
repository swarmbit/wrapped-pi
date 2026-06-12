// ============================================================
// edit-robust — Forgiving wrapper around the built-in edit tool
// ============================================================
// Wraps pi's built-in `edit` tool to be more tolerant of malformed
// arguments emitted by less-accurate models (e.g., gemma 12b).
//
// Problem:
//   The built-in edit tool's schema strictly requires every element
//   of the `edits` array to be an object with string `oldText` and
//   `newText` fields. Some models occasionally emit a stray non-object
//   entry (e.g. a trailing `true`, `null`, or a string) inside the
//   array. The TypeBox schema validation then rejects the ENTIRE
//   tool call with `edits.1: must be object`, even when other entries
//   in the same call are perfectly valid:
//
//     { "path": "x.js", "edits": [ {oldText:..., newText:...}, true ] }
//
// Fix:
//   Wrap the built-in tool's `prepareArguments` to drop invalid
//   entries from the `edits` array before schema validation runs.
//   The valid entries still get applied; only the garbage is removed.
//   If every entry is invalid, the built-in tool's own validation
//   raises a clear "edits must contain at least one replacement" error.
//
// Behavior preserved:
//   - Built-in diff renderer (no renderCall/renderResult override)
//   - The original `prepareArguments` already handles:
//       * `edits` sent as a JSON string (Opus 4.6, GLM-5.1)
//       * legacy single-edit format (oldText/newText at top level)
//   - Path resolution uses the session cwd (lazy tool creation)
// ============================================================

import {
	createEditTool,
	type EditToolInput,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function isValidEdit(edit: unknown): boolean {
	if (edit === null || typeof edit !== "object") return false;
	const e = edit as { oldText?: unknown; newText?: unknown };
	return typeof e.oldText === "string" && typeof e.newText === "string";
}

export default function (pi: ExtensionAPI) {
	// Eagerly create a prototype just to grab the schema, label, and
	// `prepareArguments`. These don't depend on cwd, so `process.cwd()`
	// is fine here.
	const proto = createEditTool(process.cwd());
	const originalPrepare = proto.prepareArguments;

	// The actual tool instance is created lazily on first execute, using
	// the session's real cwd so relative paths resolve correctly.
	let runtime: ReturnType<typeof createEditTool> | null = null;

	function wrappedPrepare(input: unknown): EditToolInput {
		// Delegate to the built-in first so we still get the JSON-string
		// and legacy single-edit handling for free.
		const prepared = (originalPrepare ? originalPrepare(input) : input) as EditToolInput;

		if (Array.isArray(prepared.edits)) {
			prepared.edits = prepared.edits.filter(isValidEdit) as EditToolInput["edits"];
		}
		return prepared;
	}

	// Registering with `name: "edit"` replaces the built-in edit tool.
	// We intentionally omit `renderCall` and `renderResult` so the
	// built-in diff renderer is inherited automatically.
	pi.registerTool({
		name: "edit",
		label: proto.label,
		description: proto.description,
		parameters: proto.parameters,
		prepareArguments: wrappedPrepare,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!runtime) {
				runtime = createEditTool(ctx.cwd);
			}
			return runtime.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
