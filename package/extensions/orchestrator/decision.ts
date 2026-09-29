import type { MemberSession, TokenUsage } from "./types";
import { normalizeUsage } from "./usage";

export interface RoutingDecision {
  action: "new" | "reuse" | "clarify";
  realId?: string;
  reason: string;
}
export interface DecisionResult {
  decision: RoutingDecision;
  usage?: TokenUsage;
}
export interface DecisionBackend {
  evaluate(text: string, candidates: MemberSession[], signal?: AbortSignal): Promise<DecisionResult>;
}

/** Explicitly configured Jev/System One compatible server (e.g. local Laya). */
export class SystemOneBackend implements DecisionBackend {
  constructor(private readonly url: string, private readonly model: string, private readonly apiKey?: string) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Use an HTTP(S) decision URL without embedded credentials.");
    }
  }

  async evaluate(text: string, candidates: MemberSession[], signal?: AbortSignal): Promise<DecisionResult> {
    if (text.length > 4000) throw new Error("Request exceeds the experimental decision input budget; clarify instead of truncating it.");
    const options: Record<string, string> = { NEW: "A separate, independent goal; no existing task context is necessary." };
    const ids = new Map<string, string>();
    candidates.forEach((candidate, index) => {
      const key = `S${index}`;
      ids.set(key, candidate.id);
      options[key] = `Continue session ${key} using its session context summary, not just similar keywords.`;
    });
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        state: { request: text.slice(0, 4000), sessions: candidates.map((item, index) => ({
          key: `S${index}`, summary: (item.summary || item.goal).slice(0, 1500),
        })) },
        questions: { route: { type: "choice", instructions: "Which session context does the request continue? Use the session context summaries, prioritizing the latest turn. Similar keywords alone do not imply continuity. Select NEW for independent work.", criteria: options } },
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Decision server returned HTTP ${response.status}.`);
    const body = await response.text();
    if (body.length > 100_000) throw new Error("Decision response is too large.");
    const payload = JSON.parse(body);
    const answer = payload?.answers?.route;
    const probabilities = answer?.probabilities;
    const choice = answer?.choice;
    if (typeof choice !== "string" || !Object.hasOwn(options, choice) || !probabilities ||
        Object.keys(probabilities).some(key => !Object.hasOwn(options, key))) {
      throw new Error("Invalid decision response or unknown candidate.");
    }
    const ranked = Object.keys(options).map(key => ({ key, score: probabilities[key] }));
    if (ranked.some(item => typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) ||
        Math.abs(ranked.reduce((total, item) => total + item.score, 0) - 1) > 0.01) {
      throw new Error("Invalid decision probabilities.");
    }
    ranked.sort((a, b) => b.score - a.score);
    if (ranked[0].key !== choice) throw new Error("Decision choice disagrees with probabilities.");
    // Route automatically above 60%; these scores are not calibrated certainty.
    const confident = ranked[0].score > 0.6;
    let usage: TokenUsage | undefined;
    if (payload.usage) {
      // System One bills input only and reports no separate prompt-cache fields.
      usage = normalizeUsage({ input: payload.usage.input_tokens, output: payload.usage.output_tokens,
        cacheRead: 0, cacheWrite: 0 });
    }
    const decision: RoutingDecision = !confident
      ? { action: "clarify", reason: "Decision scores are ambiguous; choose a task." }
      : choice === "NEW"
        ? { action: "new", reason: "Decision model selected independent work." }
        : { action: "reuse", realId: ids.get(choice), reason: "Decision model selected task continuity." };
    return { decision, usage };
  }
}

export function shortlist(text: string, members: MemberSession[], lastId?: string): MemberSession[] {
  const words = new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
  const scored = members.map(member => ({ member, score: [...words].filter(word =>
    (member.summary || member.goal).toLocaleLowerCase().includes(word)).length }));
  scored.sort((a, b) => b.score - a.score || b.member.lastActivityAt.localeCompare(a.member.lastActivityAt));
  const recent = members.find(member => member.id === lastId);
  return [...(recent ? [recent] : []), ...scored.map(item => item.member).filter(item => item.id !== lastId)].slice(0, 3);
}
