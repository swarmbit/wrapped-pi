import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function messageContext(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(item => {
    if (item.type === "text" && typeof item.text === "string") return [item.text];
    // Tool calls/results, reasoning, and images are not routing context.
    return [];
  }).join("\n");
}

/** Structured extractive context stored as a JSON string for registry compatibility. */
export function sessionContextSummary(entries: SessionEntry[]): string {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !["user", "assistant"].includes(entry.message.role)) continue;
    const content = messageContext(entry.message);
    if (content.trim()) messages.push({ role: entry.message.role as "user" | "assistant", content });
  }
  return JSON.stringify(messages.slice(-50).reverse());
}

export type ContextMessage = { role: "user" | "assistant"; content: string };

/** Decode structured summaries; invalid or absent stored data yields an empty context. */
export function decodeSessionContextSummary(summary: string): ContextMessage[] {
  let value: unknown;
  try { value = JSON.parse(summary); } catch { return []; }
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item) ||
      !["user", "assistant"].includes(item.role) || typeof item.content !== "string")) return [];
  return value.map(item => ({ role: item.role, content: item.content }));
}

/** Human-readable projection for UI and text-only consumers. */
export function readableSessionContextSummary(summary: string): string {
  return decodeSessionContextSummary(summary).map((message, index) =>
    `${index === 0 ? "Latest message" : "Earlier message"}:\\n${message.role}: ${message.content}`).join("\\n\\n");
}
