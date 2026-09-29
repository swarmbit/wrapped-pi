import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => item.text).join("\n").trim();
}

/** Bounded extractive context summary; no additional model calls or cost.
 * Recent turns come first so classifier input budgets retain the current topic.
 * Only the active branch is supplied by callers; tool results are excluded.
 */
export function sessionContextSummary(entries: SessionEntry[]): string {
  const turns: Array<{ user: string; assistant: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const text = textOf(entry.message);
    if (!text) continue;
    if (entry.message.role === "user") turns.push({ user: text, assistant: "" });
    else if (entry.message.role === "assistant" && turns.length) turns.at(-1)!.assistant = text;
  }
  return turns.slice(-3).reverse().map((turn, index) =>
    `${index === 0 ? "Latest turn" : "Earlier turn"}:\nuser: ${turn.user.slice(0, 300)}`
      + (turn.assistant ? `\nassistant: ${turn.assistant.slice(0, 150)}` : ""))
    .join("\n\n").slice(0, 1500);
}
