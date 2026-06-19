// ============================================================
// batch-tools — Encourage parallel tool calls and proactive
// tool prediction to reduce agent round-trips
// ============================================================
// Appends guidelines to the system prompt before each agent
// loop, instructing the model to:
//   1. Batch independent tool calls in a single response
//   2. Proactively predict and prefetch tools for codebase
//      research rather than discovering needs one turn at a time
//
// Uses the `before_agent_start` event which fires after the
// user submits a prompt but before the agent loop begins.
// The returned `systemPrompt` replaces the base prompt for
// that loop. If other extensions also return a systemPrompt,
// Pi chains them.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Guidelines appended to the system prompt.
 *
 * Exported so tests and the /batch command can reference it.
 */
export const BATCH_GUIDELINES = [
  "",
  "## Tool Call Batching",
  "",
  "You can call multiple tools in a single response. Use this aggressively to reduce round-trips:",
  "",
  "1. **Batch independent calls**: If tool calls do not depend on each other's results, emit them all at once. For example, reading two different files, or grepping for two different symbols — call both in the same response.",
  "2. **Predict and prefetch**: When starting a task, predict the tools you will likely need and batch them upfront. For codebase research this means:",
  "   - Batch `find` (discover file structure) + `grep` (locate symbols/imports) + `read` (files you can already guess) in one response.",
  "   - If investigating a bug, batch multiple `grep` calls for different keywords (error message, function name, class name) simultaneously.",
  "   - If exploring a new project, batch `ls` + `read package.json` + `read README` + `find` for config files.",
  "3. **Only go sequential when dependent**: Make calls one at a time only when a result determines the next call's parameters. For example, `grep` to find a file, then `read` that specific file. But if you can reasonably guess the file path, batch both.",
  "4. **Maximise throughput**: Each round-trip to the model costs time. Fewer turns with more parallel calls means faster results for the user.",
].join("\n");

/**
 * Build the enhanced system prompt by appending batching guidelines.
 *
 * Exported for testing.
 */
export function enhanceSystemPrompt(basePrompt: string): string {
  return basePrompt + "\n" + BATCH_GUIDELINES;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    return { systemPrompt: enhanceSystemPrompt(event.systemPrompt) };
  });

  // ── /batch command — show status and guidelines summary ──
  pi.registerCommand("batch:status", {
    description: "Show batch-tools extension status and guidelines",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        "batch-tools: active — guidelines appended to every agent loop",
        "info",
      );
      // Notify the first few lines as a preview
      const preview = BATCH_GUIDELINES.split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(0, 3)
        .join(" | ");
      ctx.ui.notify(`Guidelines preview: ${preview}…`, "info");
    },
  });
}
