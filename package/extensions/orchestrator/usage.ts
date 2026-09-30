import { createHash } from "node:crypto";
import type { TokenUsage, UsageEvent } from "./types";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0,
    incompleteTokens: false, incompleteCost: false };
}

/** Pi usage is already normalized: cached tokens are not part of `input`. */
export function normalizeUsage(raw: unknown): TokenUsage {
  const data = object(raw);
  const usage = emptyUsage();
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = data?.[field];
    if (finite(value)) usage[field] = value;
    else usage.incompleteTokens = true;
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const cost = object(data?.cost)?.total;
  if (finite(cost)) usage.cost = cost;
  else usage.incompleteCost = true;
  return usage;
}

export function sumUsage(usages: readonly TokenUsage[]): TokenUsage {
  const result = emptyUsage();
  for (const usage of usages) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) {
      result[key] += usage[key];
    }
    result.incompleteCost ||= usage.incompleteCost;
    result.incompleteTokens ||= usage.incompleteTokens;
  }
  return result;
}

/** Stable across forks/clones that copy entry IDs, timestamps and message data. */
export function extractUsage(entries: readonly unknown[], realId: string): UsageEvent[] {
  const result: UsageEvent[] = [];
  for (const raw of entries) {
    const entry = object(raw);
    if (!entry || typeof entry.id !== "string") continue;
    const message = object(entry.message);
    let usage: unknown;
    let category: UsageEvent["category"];
    if (entry.type === "message" && message?.role === "assistant") {
      usage = message.usage;
      category = "worker";
    } else if (entry.type === "message" && message?.role === "toolResult" && message.usage) {
      usage = message.usage;
      category = "tool";
    } else if (entry.type === "usage") {
      usage = entry.usage;
      category = entry.kind === "cache_warm" ? "warming" : "tool";
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      // Older Pi versions do not persist summary usage. Make that gap visible.
      usage = entry.usage;
      category = "summary";
    } else continue;
    const source = createHash("sha256").update(JSON.stringify([
      entry.id, entry.type, entry.timestamp, message?.timestamp,
      message?.role, message?.provider ?? entry.provider,
      message?.model ?? entry.model, message?.toolCallId,
    ])).digest("hex");
    result.push({ source, realId, category, usage: normalizeUsage(usage) });
  }
  return result;
}

/** Estimate the saved leaf's context without opening or mutating its session. */
export function savedContextTokens(entries: readonly unknown[]): number | null {
  const records = entries.map(object).filter((entry): entry is Record<string, unknown> => !!entry);
  const byId = new Map(records.filter(entry => typeof entry.id === "string").map(entry => [entry.id, entry]));
  let entry = records.at(-1);
  const seen = new Set<unknown>();
  while (entry) {
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    // After compaction, the next provider response is needed to measure the new prompt.
    if (entry.type === "compaction") return null;
    const message = object(entry.message);
    if (entry.type === "message" && message?.role === "assistant") {
      const usage = normalizeUsage(message.usage);
      return usage.incompleteTokens ? null : usage.totalTokens;
    }
    // Older flat transcripts (and lightweight test fixtures) have no parent links.
    entry = Object.hasOwn(entry, "parentId")
      ? byId.get(entry.parentId)
      : records[records.indexOf(entry) - 1];
  }
  return null;
}

/** Match Pi's normal footer token abbreviations. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function compactUsage(usage: TokenUsage): string {
  const parts = [`${usage.incompleteCost ? "partial " : "~"}$${usage.cost.toFixed(4)}`];
  for (const [field, prefix] of [["input", "↑"], ["output", "↓"], ["cacheRead", "R"], ["cacheWrite", "W"]] as const) {
    if (usage[field]) parts.push(`${prefix}${formatTokens(usage[field])}`);
  }
  if (usage.incompleteTokens) parts.push("(partial tokens)");
  return parts.join(" ");
}

export function usageLine(label: string, usage: TokenUsage): string {
  const cost = `${usage.incompleteCost ? "partial " : "~"}$${usage.cost.toFixed(4)}`;
  return `${label}: ${cost} | tokens ${usage.totalTokens.toLocaleString()}${usage.incompleteTokens ? " (partial)" : ""}`
    + ` | input ${usage.input.toLocaleString()} | cached read ${usage.cacheRead.toLocaleString()}`
    + ` | cache write ${usage.cacheWrite.toLocaleString()} | output ${usage.output.toLocaleString()}`;
}
