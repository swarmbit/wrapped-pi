import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function messageContext(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(item => {
    if (item.type === "text" && typeof item.text === "string") return [item.text];
    if (item.type === "toolCall") return [`tool call: ${item.name} ${JSON.stringify(item.arguments ?? {})}`];
    // Thinking, images, and tool outputs are not routing context.
    return [];
  }).join("\n");
}

/** Extractive routing context: ten full user/assistant messages, newest first.
 * No model calls, text truncation, thinking, or tool results. Tool names and
 * arguments are retained, including assistant messages containing only calls.
 * Callers supply only the active branch.
 */
export function sessionContextSummary(entries: SessionEntry[]): string {
  const messages: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !["user", "assistant"].includes(entry.message.role)) continue;
    const text = messageContext(entry.message);
    if (text) messages.push(`${entry.message.role}: ${text}`);
  }
  return messages.slice(-10).reverse().map((message, index) =>
    `${index === 0 ? "Latest message" : "Earlier message"}:\n${message}`).join("\n\n");
}
