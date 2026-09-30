import type { MemberSession, TokenUsage } from "./types";
import { normalizeUsage } from "./usage";

export interface RoutingDecision {
  action: "new" | "reuse" | "clarify";
  realId?: string;
  reason: string;
  /** Classifier scores, not calibrated certainty; required for automatic session changes. */
  confidence?: number;
  margin?: number;
}
export interface DecisionResult {
  decision: RoutingDecision;
  usage?: TokenUsage;
}
export interface RoutingCandidate extends MemberSession {
  isCurrent?: boolean;
  metrics?: {
    lifetimeUsage: TokenUsage;
    context: { tokens: number | null; contextWindow: number | null; estimated: boolean };
  };
}
export interface DecisionBackend {
  evaluate(text: string, candidates: RoutingCandidate[], signal?: AbortSignal): Promise<DecisionResult>;
}

export function permitsSessionChange(decision: RoutingDecision): boolean {
  const { confidence, margin } = decision;
  if (typeof confidence !== "number" || typeof margin !== "number" ||
      !Number.isFinite(confidence) || !Number.isFinite(margin) ||
      confidence > 1 || margin > 1 || margin < 0 || margin > confidence) return false;
  return (decision.action === "new" || decision.action === "reuse") &&
    confidence >= 0.8 && margin + Number.EPSILON >= 0.6;
}

/** Explicitly configured Jev/System One compatible server (e.g. local Laya). */
export class SystemOneBackend implements DecisionBackend {
  constructor(private readonly url: string, private readonly model: string, private readonly apiKey?: string) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Use an HTTP(S) decision URL without embedded credentials.");
    }
  }

  async evaluate(text: string, candidates: RoutingCandidate[], signal?: AbortSignal): Promise<DecisionResult> {
    if (text.length > 4000) throw new Error("Request exceeds the experimental decision input budget; retain the current session instead of truncating it.");
    const options: Record<string, string> = { NEW: "Only when isolation is necessary for an explicitly independent goal and no existing session can serve it. A new topic alone is insufficient." };
    const ids = new Map<string, string>();
    candidates.forEach((candidate, index) => {
      const key = `S${index}`;
      ids.set(key, candidate.id);
      options[key] = candidate.isCurrent
        ? `Stay in the CURRENT session ${key}. This is the default, including follow-ups, corrections, related work, topic drift, and uncertain requests.`
        : `Switch to session ${key} ONLY if the request requires its unique prior context and cannot be safely handled in the current session. Keyword similarity is insufficient.`;
    });
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        state: { request: text.slice(0, 4000), sessions: candidates.map((item, index) => ({
          key: `S${index}`, isCurrent: item.isCurrent === true, summary: (item.summary || item.goal).slice(0, 1500),
          metrics: item.metrics ?? null,
        })) },
        questions: { route: { type: "choice", instructions: "Stay in the current session unless changing sessions is necessary, not merely preferable. Follow-ups, pronouns such as this/that/it, corrections, refinements, tests, and related implementation work belong in the current session by default. Topic drift or a different keyword does not require isolation. Switch to another existing session only when its unique previous context is required and the current session cannot safely satisfy the request. Choose NEW only for an explicitly independent goal that requires isolation and cannot use any existing session. When uncertain, choose the current session. Use session context summaries, prioritizing the latest turn; similar keywords alone do not imply continuity. Candidate metrics report cumulative lifetime tokens and estimated USD cost, not the price of the next request. Context tokens describe current prompt size; null means unknown and incomplete flags mean partial data, not zero. Prioritize required task context over savings. Context size, token savings, and historical usage never justify changing sessions. Never abandon needed context or choose NEW solely because historical cost or lifetime tokens are high.", criteria: options } },
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
    const evidence = { confidence: ranked[0].score, margin: ranked[0].score - (ranked[1]?.score ?? 0) };
    let usage: TokenUsage | undefined;
    if (payload.usage) {
      // System One bills input only and reports no separate prompt-cache fields.
      usage = normalizeUsage({ input: payload.usage.input_tokens, output: payload.usage.output_tokens,
        cacheRead: 0, cacheWrite: 0 });
    }
    const proposed: RoutingDecision = choice === "NEW"
      ? { action: "new", reason: "Strong decision scores indicate independent work requiring isolation.", ...evidence }
      : { action: "reuse", realId: ids.get(choice), reason: "Decision model selected required task context.", ...evidence };
    const current = candidates.find(candidate => candidate.isCurrent);
    const staying = proposed.action === "reuse" && proposed.realId === current?.id;
    const decision: RoutingDecision = staying || permitsSessionChange(proposed) ? proposed
      : current
        ? { action: "reuse", realId: current.id, reason: "Insufficient evidence that changing sessions is necessary; retained the current session." }
        : { action: "clarify", reason: "Insufficient evidence for automatic routing and no eligible current session." };
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
