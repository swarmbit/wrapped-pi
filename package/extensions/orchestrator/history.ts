import type { SessionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionContext["messages"][number];

/** Resolve the saved active branch without opening/migrating a transcript. */
export function savedBranch(entries: SessionEntry[]): SessionEntry[] {
  if (!entries.length) return [];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let entry: SessionEntry | undefined = entries.at(-1);
  while (entry) {
    if (seen.has(entry.id)) throw new Error("Cyclic session branch.");
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}

/** A display-only projection. Compaction/context edits never erase raw chat history. */
export function historyMessages(branches: SessionEntry[][]): AgentMessage[] {
  const seen = new Set<string>();
  const entries = branches.flat().filter(entry => {
    if (entry.type !== "message" && entry.type !== "custom_message") return false;
    // Copied entries retain their identity and timestamp; unrelated short-ID collisions do not.
    const key = JSON.stringify([entry.id, entry.timestamp, entry.type,
      entry.type === "message" ? entry.message : [entry.customType, entry.content, entry.display, entry.details]]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries.flatMap(entry => {
    if (entry.type === "message") return (entry.message.role as string) === "system" ? [] : [entry.message];
    if (entry.type === "custom_message") return [{ role: "custom" as const, customType: entry.customType,
      content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) }];
    return [];
  });
}
