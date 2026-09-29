export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  incompleteTokens: boolean;
  incompleteCost: boolean;
}

export interface VirtualSession {
  id: string;
  name: string;
  createdAt: string;
  lastRealSessionId?: string;
}

export interface MemberSession {
  id: string;
  virtualId: string;
  file: string;
  name: string;
  goal: string;
  summary: string;
  lastActivityAt: string;
  origin: "created" | "attached";
  baselineSources: string[];
}

export interface UsageEvent {
  source: string;
  realId?: string;
  virtualId?: string;
  category: "worker" | "tool" | "summary" | "warming" | "decision";
  usage: TokenUsage;
}

export interface RequestRecord {
  id: string;
  virtualId: string;
  realId?: string;
  state: "pending" | "dispatching" | "completed" | "interrupted";
  reason?: string;
}

export interface Registry {
  version: 1;
  workspace: string;
  virtualSessions: VirtualSession[];
  members: MemberSession[];
  usage: UsageEvent[];
  requests: RequestRecord[];
  lastSelectedVirtualId?: string;
}

/** Process-local plain data survives Pi's extension replacement, never contexts. */
export interface RuntimeState {
  activeId?: string;
  enabled: boolean;
  boundSessionId?: string;
  busy: boolean;
  epoch: number;
  transition?: { reason: "new" | "resume"; virtualId: string; targetFile?: string };
  pending: Map<string, { text: string; virtualId: string }>;
  history: Map<string, string>;
  heldDrafts: string[];
}
