# Pi Multi-Session Orchestrator Specification

Status: Draft for review  
Scope: Session orchestration and context management; not implementation  
Working name: Pi Orchestrator

## 1. Purpose

Build a Pi extension that presents a **named virtual orchestrator session** over a collection of focused, persistent real Pi sessions. Users enable it through `/orchestrator` and then type normally in the existing terminal editor; they do not need to prefix each message with a routing command.

A decision model evaluates whether a request continues existing work or starts independent work. A deterministic policy selects the real session and decides whether its context needs compaction before execution. The virtual session persists independently of the currently displayed real session and can be enabled again from any eligible real session.

The objective is **the lowest total cost per successfully completed task, subject to acceptable quality and latency**. Minimizing input tokens alone is not sufficient.

The system should avoid growing a single conversation across unrelated topics, while retaining the context needed for follow-ups and long-running tasks.

## 2. Goals and non-goals

### Goals

- Reuse sessions when their context is necessary or useful for the request.
- Create focused sessions for independent tasks, even within the same broad topic.
- Return to previously paused tasks without replaying unrelated conversations.
- Compact relevant sessions when required by context limits, and eventually when justified by expected savings.
- Preserve decisions, constraints, artifacts, and unresolved work across session transitions.
- Account for routing, execution, handoff, compaction, and cache-warming overhead.
- Explain and audit every routing decision.
- Support interchangeable hosted and local decision models.
- Preserve Pi's session persistence, tools, permissions, and recovery behavior.
- Name, list, rename, and resume virtual orchestrator sessions independently of real Pi sessions.
- Wrap the configured editor where supported, preserving its behavior rather than imposing a new editing experience.
- Display virtual-session counts, real-session counts, and separate aggregate/current-session cost and token statistics.

### Non-goals for the MVP

- Parallel agents modifying a shared workspace.
- Autonomous splitting of a single request into multiple tasks.
- Switching physical models after every tool call.
- Training a new decision model.
- Guaranteeing provider cache residency or transferring caches across models.
- Autonomous cross-workspace or cross-user context sharing.
- Replacing Pi's transcript format or compaction implementation.
- A production graphical interface.
- Transparent automatic routing of RPC, print, or other non-editor submissions in the MVP.
- Merging all underlying real transcripts into a synthetic conversation.

## 3. Key concepts and invariants

### 3.1 Two independent decisions

Session assignment and context management are separate:

1. **Assignment:** reuse an existing session, create a session, or ask for clarification.
2. **Context management:** keep the selected context or compact it.

Reusing a session can require compaction. Starting a new topic does not require compacting the old session.

### 3.2 Sessions represent task continuity

A session belongs to a coherent goal and its dependent follow-ups, not merely a keyword or broad subject.

Examples:

- “Fix the callback test for the OAuth implementation” continues the OAuth task.
- “Add a login form to another application” is a separate task despite the shared authentication topic.
- “Now add tests for that” depends on the most recent relevant interaction.
- “Explain why the implementation uses PKCE” can remain in the implementation session.

### 3.3 Pi context behavior

- Each session has an authoritative persisted transcript and active branch.
- A request uses that session's current projected context, including compaction summaries and retained messages.
- Model switching within a session does not create separate per-model conversation histories.
- A fork or clone that retains history is not equivalent to a fresh session with a small handoff.
- Original entries remain available after compaction; compaction changes what is sent, not the historical record.

### 3.4 Provider cache behavior

- Provider prompt caches are independent of local session persistence.
- Cache compatibility depends on the physical model, endpoint, account scope, encoded prompt, and provider rules. Cross-model/provider reuse must not be assumed.
- Opening a persisted session or keeping an SDK object alive does not guarantee a warm cache.
- A provider caches only requests it actually receives; another session or model's activity does not update that cache.
- Compaction changes the prefix and can reduce reuse beyond any unchanged system/tool prefix.
- Cache age and prior cache-hit observations are estimates, not proof of residency.
- Cached input still occupies the model's context window.

### 3.5 Decision-model authority

The decision model recommends semantic relationships. It does not authorize tools, change permissions, select arbitrary transcript paths, or fabricate token prices/cache hits.

Policy code validates all recommendations and makes the final decision.

### 3.6 Virtual orchestrator sessions versus real sessions

- A **virtual orchestrator session** is a persistent named routing namespace and usage aggregate, not a Pi transcript, physical inference model, or provider cache.
- A **real session** is a normal Pi session with its own transcript, active branch, name, and context. Only the selected real session supplies conversation history to the worker.
- Virtual sessions are distinct from Pi's virtual models. The two features can coexist but serve different purposes.
- Each virtual session has an immutable ID and a nonempty user-visible name, unique within its workspace/principal scope. Renaming does not change identity, membership, or usage.
- Each real session belongs to at most one virtual session in the MVP. Existing real sessions require explicit attachment; enabling a virtual session must not silently import the current transcript or its previous costs.
- All orchestrator-created real sessions receive a descriptive Pi session name, for example `Project Atlas / OAuth callback`. Name collisions are resolved without changing IDs.
- Switching real sessions inside a virtual session does not disable orchestration. The current UI session and virtual-session identity are separate state.
- Enabling an existing virtual session from another real session resumes its last selected real session, subject to validation. The entry session remains intact and is not automatically adopted.
- `/orchestrator off` disables routing and leaves the currently displayed real session available for ordinary Pi use. It does not delete, compact, or detach any session.
- “From any real session” means no special anchor transcript is required. Workspace/principal boundaries still apply: switching from an incompatible workspace requires an explicit workspace transition, not silent cross-workspace context sharing.

### 3.7 Transcript and aggregate scope

The virtual session has metadata, a request timeline, and a usage ledger, but no merged model context. Its cards and routing history are not automatically injected into every worker prompt. The terminal continues to display the selected real transcript, with a persistent virtual-session status widget identifying the enclosing group.

## 4. Architecture

```text
Pi terminal editor (existing custom editor or Pi CustomEditor)
    |
    v
Submission decorator -- ordinary commands/bypass --> normal Pi behavior
    |
    v
Internal /orchestrator command with opaque request reference
    |-- active named virtual-session identity
    |-- request admission and deduplication
    |-- member-session cards and candidate retrieval
    |-- decision-model adapter and deterministic policy
    |-- usage ledger and status widget
    |
    v
Pi extension command context
    |-- wait for safe idle boundary
    |-- newSession / switchSession with fresh withSession context
    |-- compact and await callback outcome
    |-- deliver the preserved request exactly once
    |
    v
Real Pi session --> physical inference provider and workspace tools
```

The extension owns session selection and virtual metadata. Pi owns execution, safety controls, terminal rendering, and authoritative real-session persistence. The orchestration core is independent of the UI adapter so a later SDK host can reuse it.

### Components

| Component | Responsibility |
| --- | --- |
| Editor adapter | Decorate submissions while retaining current editing behavior and callbacks |
| Command controller | `/orchestrator` management, safe session replacement, and dispatch |
| Virtual-session registry | Names, IDs, membership, last selected real session, and activation state |
| Real-session registry | Cards, Pi file references, names, and projection revisions |
| Candidate retriever | Find related members of the active virtual session |
| Decision adapter | Evaluate continuity with typed, validated output |
| Policy engine | Apply semantic thresholds, safety rules, budgets, and fallback behavior |
| Usage ledger | Attribute unique usage events to real/virtual sessions and overhead |
| Status UI | Show counts, selected identities, costs, and token breakdowns |

MVP implementation target: a TypeScript Pi extension with a reusable orchestration core, persistent extension metadata in SQLite, and native Pi transcript files. SQLite remains a proposed storage choice, not a required dependency change to this repository.

### 4.1 `/orchestrator` commands

| Command | Behavior |
| --- | --- |
| `/orchestrator` | Show named virtual sessions and current activation; allow selecting/creating one |
| `/orchestrator new <name>` | Create a named virtual session and enable automatic editor routing |
| `/orchestrator on <name-or-id>` | Enable an existing virtual session from any eligible real session |
| `/orchestrator off` | Disable routing without deleting or changing the current transcript |
| `/orchestrator list` | List virtual sessions with real-session counts and aggregate usage/cost |
| `/orchestrator status` | Show detailed virtual/current-real totals and attribution breakdown |
| `/orchestrator rename <new-name>` | Rename the active virtual session without changing its ID |
| `/orchestrator sessions` | List named real members and their context/usage; allow explicit selection |
| `/orchestrator attach [name-or-id]` | Explicitly attach the current unowned real session; an argument selects its virtual owner without first switching away |
| `/orchestrator drafts` | Recover held, unsent drafts; do not execute them automatically |

Names containing spaces support quoting and a picker. Duplicate names in the same scope are rejected. Unknown or ambiguous names must not create a new virtual session silently. Management commands produce no worker turn unless explicitly submitting a task.

Creating a virtual session initially creates only registry metadata. Its first ordinary request creates a named real session unless a real session was explicitly attached. Activation can resume the last valid member, but does not create a new real session merely to provide an anchor. If no valid member exists, remain in the entry UI session until first dispatch.

Automatic routing remains enabled across orchestrator-driven real-session replacements. Activation is window/runtime-local; another Pi process can independently select a different virtual session. Registry metadata is persistent. On application restart or `/reload`, show a resume option for the last selection rather than silently routing unrelated work. Internal member switches restore the active virtual identity without retaining stale extension contexts.

Ordinary `/resume`, `/new`, `/tree`, and `/clone` retain their normal Pi semantics. A user-directed switch away from the managed member set suspends automatic routing and shows an explicit resume notice; it does not implicitly attach the destination. Internal replacements are marked separately so they do not trigger this suspension. Branch changes refresh the selected member's card and projection reference.

### 4.2 Editor extension and compatibility

Preferred implementation is a **submission decorator around the existing editor factory**, not a replacement editor design:

1. Read `ctx.ui.getEditorComponent()` and retain the configured factory, if any.
2. Install a factory through `ctx.ui.setEditorComponent()` that creates the underlying editor from that original factory. When no custom factory exists, instantiate a minimal subclass of Pi's exported `CustomEditor`.
3. Delegate the editor contract and optional capabilities to the underlying implementation. Forward rendering, invalidation, keyboard/mouse handling, focus/cursor state, text access, expanded paste text, history, autocomplete, appearance settings, and disposal where implemented.
4. Decorate the host-provided `onSubmit` callback, including callbacks Pi assigns after factory creation; a callback set inside the factory alone can be overwritten by Pi. Preserve `onChange` and forward application-control callbacks/properties expected by Pi's duck-typed integration.
5. Intercept only ordinary user submissions while automatic routing is active. Pass slash commands, shell prefixes (`!`/`!!`), empty submissions, and explicit bypass submissions through unchanged. Do not capture ordinary editing keys or globally intercept raw Enter bytes.
6. Keep the original user text in history and in the real transcript. An opaque internal command carries a request reference, not embedded user text that could be reparsed as commands or corrupted by quoting/newlines.
7. Restore the saved factory on disable, preserving the draft. Do not overwrite a newer factory installed by another extension; detect ownership conflicts and suspend routing instead.

`getEditorComponent()` exposes a factory, not the live editor instance. Installing a decorator can recreate the editor and preserve text, but cannot promise preservation of private state such as undo history, cursor selection, or a modal editor's current mode. Avoid repeated reinstalls on ordinary requests and document activation-time limitations. Do not access private Pi editor fields or monkey-patch interactive-mode internals.

A wrapper must bind delegated methods correctly and expose relevant capabilities rather than using a minimal facade that drops Pi keyboard handlers. Nonstandard editors with incompatible submit semantics must produce an actionable compatibility warning instead of being silently replaced. When a pinned Pi version lacks the factory getter, require an explicit reduced-compatibility opt-in or keep manual command routing; never claim full editor preservation.

Multiple extensions can replace the editor. Installation order, ownership, `/reload`, session replacement, late callback assignment, and cooperative factory wrapping must be tested. Coexistence is best-effort for unknown private APIs, not an unconditional guarantee. Existing footer/editor styling remains owned by its original extension; the orchestrator uses its own keyed status/widget instead of replacing those components.

### 4.3 Submission envelopes and unsupported paths

Preserve input as a request envelope: original text, expanded paste contents, supported attachments, origin, draft/history data, active virtual ID, and a unique request ID. Deliver through the destination's fresh context once, with an internal-origin bypass guard so extension-generated input does not route recursively.

The editor callback's documented payload is text. It does not itself expose Pi's pending image attachments. Attachment capture and clearing must therefore be verified through supported APIs in the pinned release. Do not assume an internal slash command carries images, and do not let a switch discard pending images. Until an attachment-safe path is demonstrated, block automatic rerouting of affected submissions with a clear bypass/manual-continuation option that preserves the original draft and attachments. This is a compatibility gate, not permission to drop data.

During active execution, do not convert native steering/follow-up shortcuts into cross-session switching. Preserve those controls as current-real-session deliveries and attribute their work there. Ordinary routed submissions must wait for a safe boundary or be held in an extension-owned queue; queued envelopes remain bound to the virtual identity selected at submission time. They must be visible, cancellable, and retained on routing failure. Non-editor inputs follow native Pi behavior unless using an explicit command-based adapter; the UI must not imply they are automatically routed.

## 5. Data contracts

The following schemas describe extension-owned data. They are not Pi SDK types.

### 5.0 Virtual session and real-session membership

```typescript
interface VirtualSession {
  id: string;
  name: string;
  workspaceId: string;
  principalId: string;
  status: "open" | "archived";
  createdAt: string;
  updatedAt: string;
  revision: number;
  lastRealSessionId?: string;
  lastUserVisibleRequestId?: string;
  policyVersion: string;
}

interface SessionMembership {
  virtualSessionId: string;
  realSessionId: string;
  attachedAt: string;
  usageStartRef: string; // immutable boundary; pre-attachment work is excluded
  origin: "created" | "attached";
}
```

Virtual names and membership are stored outside the real transcript. Optionally mirror a reference into Pi custom metadata for discovery, never as model instructions. Registry metadata is authoritative for names/membership, while cards remain rebuildable from real transcripts. A real session's existing `/name` is preserved when explicitly attached; newly created real sessions receive generated descriptive names.

### 5.1 Request

```typescript
interface BrokerRequest {
  id: string; // idempotency key
  workspaceId: string;
  virtualSessionId: string; // captured at submission, not looked up again after queueing
  sourceRealSessionId?: string;
  origin: "editor" | "explicit_command";
  input: string;
  attachments?: AttachmentReference[];
  receivedAt: string;
  sessionOverride?:
    | { kind: "new" }
    | { kind: "reuse"; sessionId: string };
}
```

Workspace identity must cover the canonical directory and applicable trust/permission boundary. In multi-user deployments it must also be scoped by principal. Attachment metadata may be used for routing; unsupported modalities must not silently disappear.

### 5.2 Session card

```typescript
interface SessionCard {
  id: string; // real Pi session identity
  workspaceId: string;
  virtualSessionId: string;
  piSessionFile: string;
  revision: number;
  projectionRef: string; // active branch/leaf and compaction revision
  title: string;
  goal: string;
  summary: string;
  status: "open" | "completed" | "archived";
  executionState: "idle" | "running" | "compacting" | "interrupted";
  unresolvedItems: string[];
  decisions: string[];
  artifacts: ArtifactReference[];
  topicTags: string[];
  lastActivityAt: string;
  selectedModel: { provider: string; id: string; thinkingLevel: string };
  lastPhysicalModel?: { provider: string; id: string; thinkingLevel?: string };
  contextTokens?: number;
  contextEstimateSource?: "provider" | "pi" | "broker";
  cardFreshness: "current" | "stale" | "unknown";
}
```

Cards are bounded routing aids, not authoritative memory. Claims and artifacts should reference supporting transcript entries when available. A completed task may still receive a dependent follow-up; completion does not automatically exclude reuse.

Do not use cumulative lifetime token usage as current context size. Do not infer actual file contents from a card: another session, user, or process may have changed the workspace.

### 5.3 Decision-model assessment

```typescript
interface ContinuityAssessment {
  candidates: Array<{
    sessionId: string;
    relation: "continuation" | "related_independent" | "unrelated" | "uncertain";
    relevanceScore: number; // validated normalized score, not assumed probability
    requiredContext: string[];
    evidenceRefs: string[];
  }>;
  independentTaskScore: number;
  ambiguity: "low" | "high";
}
```

Implementations may map a Jev-style typed questions API or another classifier onto this contract. Score meaning and calibration must be documented for each adapter. Model-reported confidence is not treated as a calibrated probability without validation.

The adapter must support a strict output schema, timeouts, bounded input, and explicit errors. Candidate IDs must belong to the retrieved allowlist. Natural-language explanations are optional and must not be required from non-generative decision models.

### 5.4 Final decision and execution record

Each record must include:

- Request ID, virtual-session ID, source/destination real-session IDs, and policy/model versions.
- Candidate IDs, card revisions, and assessment results.
- Assignment: `reuse`, `create`, or `clarify`.
- Selected session and whether selection came from an explicit override.
- Context action: `keep` or `compact`, with reason codes.
- Relevant handoff references, if any.
- Cost/latency estimates and uncertainty at decision time.
- Actual execution outcome, usage, and user correction when known.

Reason codes include `EXPLICIT_SELECTION`, `DEPENDENT_FOLLOWUP`, `INDEPENDENT_TASK`, `AMBIGUOUS_REFERENCE`, `WORKSPACE_MISMATCH`, `CONTEXT_LIMIT`, `ECONOMIC_COMPACTION`, and `DECISION_MODEL_UNAVAILABLE`.

## 6. Request lifecycle

1. **Capture:** the editor decorator preserves an ordinary submission and invokes the internal command path with an opaque request reference.
2. **Admit:** validate the envelope, virtual/workspace identity, compatibility, and deduplication state.
3. **Apply override:** honor a valid explicit real-session selection or forced-new request.
4. **Retrieve:** shortlist eligible cards within the active virtual session, workspace, and principal.
5. **Assess:** call the decision adapter unless a deterministic fast path suffices.
6. **Choose:** persist the destination real-session identity and decision before dispatch.
7. **Prepare:** wait for idle, acquire the execution lease, verify revisions, and create/switch through the command context. Continue only inside the fresh `withSession` context after replacement.
8. **Validate context:** include incoming input, attachments, and response/tool-result headroom; use callback-based extension compaction and wait for a confirmed outcome when required.
9. **Execute:** deliver the preserved input exactly once without editor/internal-command artifacts or recursive routing. Preserve Pi streaming and permissions.
10. **Settle:** observe Pi's actual settled boundary, including queued work/recovery, rather than treating every low-level `agent_end` as completion.
11. **Update:** reconcile finalized usage, refresh the selected real-session card, update virtual aggregates/widget, and release the lease.

Assignment and compaction must not run concurrently with an active tool sequence. The MVP is sequential. Native steering/follow-up controls remain in the current real session as described in section 4.3; cross-session assignment waits for settlement.

## 7. Session assignment policy

### 7.1 Candidate retrieval

MVP retrieval uses bounded recent cards plus lexical matching on goals, summaries, artifacts, and unresolved work. Retrieve only real members of the active virtual session, scoped to workspace/principal. Unowned or other virtual sessions' transcripts are not candidates unless explicitly attached under policy. Always include the virtual session's last user-visible real session when eligible, since pronouns and short follow-ups depend on interaction history. The unrelated real session used to activate the virtual session is not an antecedent merely because it was displayed recently.

Later versions may add embeddings. Retrieval similarity is not the final assignment decision.

Candidate limits and input budgets must be configurable. A local classifier with a small context window receives a shortlist of short cards, not full transcripts. If necessary evidence will not fit, escalate or clarify rather than silently truncating it.

### 7.2 Reuse

Reuse when a candidate is a sufficiently strong continuation match and no isolation rule blocks it. Require a configurable margin between the best candidate and alternatives to avoid arbitrary selection.

The policy should be conservative about losing necessary context. Recency alone cannot justify reuse, but recent referential follow-ups should favor continuity when unambiguous.

### 7.3 Create

Create when the request expresses an independent goal, no eligible session contains necessary context, or the user explicitly requests a new session.

Leave other sessions intact. Do not automatically compact or delete them just because another topic begins.

### 7.4 Clarify

Ask the user when an ambiguous reference could materially change the task, workspace effects, or required context. Present a short candidate list and a new-session option.

For non-interactive clients, return a typed clarification-required result instead of guessing.

### 7.5 Fallback

If the classifier times out, fails validation, or is unavailable:

- Valid explicit overrides still work.
- An obvious dependent follow-up may reuse the last eligible session under deterministic policy.
- An explicitly independent task may start a new session.
- Otherwise clarify; never silently drop required context to save cost.

Thresholds and score margins are tuned against labeled routing examples, not selected as universal constants.

## 8. Compaction policy

### 8.1 Mandatory compaction

Keep Pi's automatic compaction enabled as a safety net. The broker also checks context before dispatch using the selected physical model's limits where known and reserves enough headroom for output and tool continuations.

If required compaction fails, do not proceed with a request known to exceed the budget. Return a recoverable error or request a user-approved alternative. A fresh session is not a silent substitute for required task history.

If virtual models are allowed, Pi's routed-model checks remain authoritative; the broker must not assume the virtual model's advertised limit applies to every route.

### 8.2 Proactive economic compaction

Deferred until after MVP evaluation. Compact below the hard threshold only when expected downstream savings justify the summary and rebuild costs at acceptable information-loss risk.

Additional safeguards:

- No compaction solely because a session is old or paused.
- Prefer safe settled boundaries and preserve recent details.
- Apply a cooldown/minimum context-growth rule to prevent repeated compaction.
- Preserve exact identifiers, constraints, decisions, unresolved work, and artifact references.
- Treat summary generation as a generative-model operation; a decision-only classifier cannot write the summary.
- Follow Pi's valid cut boundaries; never split tool calls from their results by manually slicing messages.

## 9. Context transfer and shared memory

Creating a session normally starts with a fresh transcript. When prior work is relevant but does not justify retaining the old conversation, attach a bounded handoff containing only necessary facts:

- Goal and constraints.
- Relevant decisions and their provenance.
- Artifact references and their observed revision when available.
- Outstanding dependencies or work to verify.

Do not copy whole transcripts by default. Handoff creation is optional, charged to orchestration overhead, and subject to the same workspace/principal boundary as retrieval.

Keep stable project instructions separate from task memory. Do not automatically promote session summaries into global instructions. Treat retrieved text and summaries as data, not permission or policy changes.

## 10. Cost and latency model

For each feasible action, estimate:

```text
Total incremental cost =
    decision and retrieval overhead
  + handoff/card-generation overhead
  + compaction overhead
  + expected uncached input cost
  + expected cached-read/cache-write cost
  + expected output cost
  + applicable warming overhead
```

Use provider-specific accounting conventions and catalog prices. Do not double-count cached tokens if an upstream API reports them as a subset of input; normalize before aggregation. Avoid counting the same Pi usage event twice.

Where cache probability is estimated, expose the assumption and evaluate conservative cache-hit and cache-miss scenarios. Prices and model metadata are versioned. Unknown prices must be marked unknown, not converted into zero cost.

For subscription providers, API-equivalent token cost is an estimate, not necessarily an invoice or quota measurement. Track actual quota signals only when exposed.

Latency estimates should distinguish routing latency, summary latency, time to first token, and full completion time. A cache miss may increase prefill time; a new session can reduce input volume but introduce reconstruction work.

The classifier judges continuity and task requirements. Policy code performs arithmetic and applies quality constraints. A cheaper action must not override a required-context or isolation constraint.

### 10.1 Usage scopes and session counts

Show both virtual and real statistics with explicit labels:

| Scope | Meaning |
| --- | --- |
| Virtual sessions created | Number of persistent virtual-session records ever created in the current workspace/principal scope; show archived count separately |
| Active virtual session | Its name/ID and aggregate observed usage/cost across all members after membership boundaries, plus orchestration overhead |
| Real sessions created | Number of real sessions created by this virtual session; show explicitly attached sessions separately |
| Real sessions available | Number of current members, including archived/completed members with separate status counts |
| Current real session | Its descriptive name/ID and full observed lifetime usage/cost, including work before explicit attachment |
| Current real contribution | The portion attributed to the active virtual session after the membership boundary |
| Current context | Selected real session's estimated projected context and model capacity, not cumulative usage |

Group total and current-real total are two views, not amounts to add together. For newly created members, current-real lifetime usage normally equals its member contribution. For attached sessions, the UI must disclose the difference and offer both values. Other virtual sessions' totals are available in `/orchestrator list`, not automatically included in the active virtual total.

Creation counts do not increase on activation, reuse, rename, compaction, or process restart. A cancelled creation that produces an orphan real file is reported separately, not counted as a successful member. Archival does not erase expenditure or reduce historical created counts. The MVP does not support implicit membership transfer.

### 10.2 Token and cost fields

Every aggregate and per-real-session detail view exposes, where reported:

- **Uncached input/read tokens:** normalized Pi-style `input`, excluding cache-read and cache-write categories.
- **Cache-read tokens:** `cacheRead`, the cached prefix tokens read for inference. Label these `cached read`, not simply `read`.
- **Cache-write tokens:** `cacheWrite`, when separately reported by the provider.
- **Prompt tokens processed:** uncached input + cache read + cache write, using mutually exclusive normalized categories.
- **Output tokens:** normalized provider output usage.
- **Total tokens:** prompt + output for the canonical aggregate; retain provider raw totals separately for diagnostic discrepancies.
- **Reasoning tokens:** show separately only if reported, with a note when already included in output; do not add them twice.
- **Cost:** input, cached-read, cache-write, output, and total cost breakdown, with currency, price provenance, and estimated/actual status.
- **Calls:** worker, classifier, summary, and warming request counts where observable.

“Read tokens” here means inference input tokens, not file-tool bytes. Prefer the unambiguous UI label `input (uncached)` alongside `cached read` and `cache write`.

Provider omissions remain unknown/incomplete. A classifier or local model without token accounting must not receive fabricated usage. Locally executed models can show measured latency and reported tokens, but monetary operating cost remains unpriced unless a configured local-cost model exists. A provider reporting zero output tokens for decisions may legitimately contribute input usage only.

### 10.3 Additive ledger and overhead categories

```text
Virtual total =
    sum(unique real-member usage after attachment boundaries)
  + unique orchestration-only usage
```

Break this total into worker inference, decision classification, card generation, handoff generation, compaction/branch summaries, and cache warming. Compaction and warming already recorded in a real transcript are part of real-member usage; classify them for the breakdown without adding them again as overhead.

Each ledger event has a stable identity, timestamp, virtual ID, optional real ID/request ID, provider/physical model, category, normalized usage, cost provenance, and source reference. Source references identify actual assistant usage, persisted Pi usage entries, summary entries, or extension-owned classifier calls. Where available, retain the upstream request/response ID.

Record actual observed expenditure even for retries, failed responses with reported usage, cancelled routing calls, and abandoned branches. Billing totals are not derived solely from the current active branch. Copied/forked/cloned historical usage is not new inference and must not be recounted; reconcile stable source identities/provenance globally. Subsequent calls in a copied session are new events. For imported history without enough provenance, disclose uncertainty rather than claim an exact aggregate.

Work performed directly in an owned real session after its membership boundary remains attributable to its virtual session even when automatic routing is off. Disabling changes input behavior, not past ownership. Explicit attachment excludes all earlier work from virtual totals. Persist membership boundaries and reconcile later transcript activity, including work performed outside this terminal, without claiming unobservable extension-only calls were captured.

UI refresh is event-driven for observed finalized usage; reconcile persisted entries after settlement, resume, compaction, and restart. Optional in-progress estimates must be labeled and replaced, not added, when finalized usage arrives. Aggregate reads must not invoke inference or warm caches. Unknown cost components produce a labeled partial total, not an apparently complete dollar figure.

### 10.4 Status UI

Use a keyed status line plus a compact widget, preserving existing footer/editor providers. Example layout (illustrative values):

```text
Orchestrator: Project Atlas | virtual created: 3 | real created: 4 (+1 attached)
Current real: OAuth callback | context: 24k / 200k | routing: on
Virtual total: ~$1.24 | real lifetime: ~$0.38 | member contribution: ~$0.31
Virtual tokens: 210k | input: 30k | cached read: 170k | cache write: 0 | output: 10k
Real tokens: 80k | input: 12k | cached read: 64k | cache write: 0 | output: 4k
```

Mark subscription/catalog-based costs as estimates, as illustrated by `~`. Narrow terminals may collapse the token rows, but `/orchestrator status` must always expose the full breakdown for both scopes, ownership boundaries, created/attached counts, known/unknown costs, and worker-versus-orchestration overhead. Render from ledger snapshots, never recompute by walking every transcript on each frame.

When enabled with no selected member, display `real: pending first request` and zero known worker usage, while still counting any actual classifier overhead. When suspended/off, the indicator must say so rather than suggesting incoming prompts are being routed.

## 11. Pi integration requirements

The MVP uses supported extension APIs, not direct transcript mutation or a second hidden agent host:

- `pi.registerCommand("orchestrator", ...)` for management and the internal dispatch subcommand.
- `ctx.ui.getEditorComponent()` / `setEditorComponent()` for cooperative editor-factory decoration; `CustomEditor` as the default-editor base.
- `ctx.waitForIdle()`, `ctx.newSession(...)`, and `ctx.switchSession(path, ...)` from command-handler contexts.
- `withSession(freshCtx)` for post-replacement work. Rebind lifecycle/UI work to the new runtime and never retain the original context as a session-switch capability.
- `freshCtx.sendUserMessage(...)` for preserved input delivery, with explicit control of prompt-template expansion and internal routing bypass.
- `ctx.getContextUsage()` and read-only session-manager access for observation.
- `ctx.compact({ customInstructions, onComplete, onError })` for extension-triggered compaction; this is callback-based, not the awaited SDK `session.compact()` API.
- `pi.setSessionName(...)` / `getSessionName()` for real-session names.
- Keyed `ctx.ui.setStatus()` / `setWidget()` for the virtual-session overlay.
- `agent_settled`, session-start/switch, compaction, and finalized-message events for card/usage reconciliation.

Session replacement is command-context-only. An ordinary `input` or `before_agent_start` handler must not be assumed to expose safe `newSession()` / `switchSession()` methods. Editor submissions enter the command path before any real worker input is persisted.

The `SessionManager` remains authoritative for reconstructed context. Do not replace history by assigning `session.agent.state.messages` or slicing persisted tool exchanges. Listing/read-only inspection may use supported Pi session utilities; session replacement belongs to the host.

Keep Pi's existing sandbox, trust, extensions, and confirmation behavior in the selected real session. Verify reload/replacement behavior rather than assuming extension factories or editor callbacks survive unchanged. Later SDK hosting must explicitly recreate equivalent safety and resource configuration.

Worker model selection happens only when creating a new real member. Configure an allowlist of `{ model: provider/model, summary }` entries under `orchestrator.models` in user or project `wpi.yml`; a supplied project list replaces the user list. A separate selector question considers the initial request, bounded source context, current model, and the available configured models' summaries. It chooses only the worker model, not the routing action or session. Invalid, unavailable, or ambiguous selection falls back to the source session's current model. The replacement runtime applies and persists the chosen or fallback model through Pi's native `setModel` before any worker request; if neither can be applied, hold delivery. Reuse and resume must not trigger selection or override the saved model. The selector model is configured independently through the decision backend. Automatic mid-session model optimization remains out of scope.

The current repository declares an older Pi dependency range than the installed documentation consulted for this draft. Before implementation, pin a tested Pi version and verify the referenced APIs, event semantics, and safety integration against that version. This document does not authorize a dependency upgrade.

## 12. Persistence, concurrency, and recovery

- Real-session cards and indexes are derived from Pi transcripts and must be repairable. Virtual-session names, membership boundaries, and orchestration-only usage have their own authoritative registry/ledger and must be backed up.
- Activation is independent of the current real-session ID; do not store the only reference to a named virtual session inside its first real transcript.
- New member creation must reconcile real-session ID/file, virtual membership, and naming after cancellation or crash; no orphan should silently count as a successful dispatch.
- Persist request-to-session assignment before dispatch to avoid duplicate sessions on retries.
- Use one broker execution lease per workspace in the MVP and a session lease/revision check for transcript updates.
- Use atomic transactions for broker metadata; do not assume a transaction can span Pi transcript files and SQLite.
- Reconcile card projection references after crashes, compaction, or externally modified session files.
- Detect simultaneous external Pi writers and refuse/coordinate access; an internal lease alone cannot lock out another process.
- Update cards at settlement, not on each streamed token. Reuse finalized output where practical; separately generated cards incur usage and require provenance.
- If execution is interrupted, retain its transcript and mark the request/session interrupted.
- Do not automatically replay an interrupted request whose tools may have made side effects. Require reconciliation or an explicit resume decision.
- Repeating a completed request ID returns the existing outcome/reference rather than executing again. Reusing an ID with different content is an error.
- Archived sessions remain stored and excluded by default; explicit reopening is supported. No automatic deletion in the MVP.

## 13. Security and privacy

- Scope retrieval, handoffs, and caches of extension metadata by virtual session, workspace, and principal. Explicit activation does not authorize importing unrelated real sessions.
- Preserve existing sandbox, confirmation, and tool permission enforcement in every worker.
- Never route secrets from a local-only workspace to a hosted classifier without explicit policy approval.
- Treat prompts, session cards, tool output, and decision responses as untrusted content for policy purposes.
- Enforce allowlisted session IDs and broker-owned session-file mappings; no model-supplied filesystem paths.
- Log metadata and reason codes by default; raw routing prompts/transcripts require an explicit retention policy.
- Redact credentials from telemetry and generated artifacts.
- Never treat a continuity decision as authorization for consequential tool actions.

## 14. Observability and evaluation

### Metrics

- Routing accuracy: correct reuse, correct creation, missed continuity, and unrelated-history reuse.
- Candidate recall: whether the appropriate session entered the shortlist.
- Clarification rate, user override rate, and overrides after an incorrect decision.
- Task completion quality, repair requests, and repeated discovery work.
- Virtual-session creation counts, member creation/attachment counts, and reuse frequency.
- Current real context size, virtual aggregate usage, real-lifetime usage, and member contribution.
- Actual uncached input, cached-read, cache-write, output, reasoning (when reported), and total usage.
- Decision, handoff, card, compaction, and warming overhead.
- Routing latency, time to first token, and end-to-end latency.
- Estimated versus realized savings and cache-hit assumptions.

### Baselines

Compare against:

1. One growing session per workspace with Pi's default compaction.
2. A fresh session per request.
3. User-selected sessions with no classifier.

Use the same representative task sequence, physical model policy, tools, and success criteria where possible. Include total overhead and downstream repair work, not only the first inference call. Routing models must be evaluated on the actual workload; model size or vendor benchmarks are not sufficient.

Start in shadow mode: record proposed routing without changing the user's selected session. Use labeled examples and user corrections to tune policy before automatic assignment. Enabling automatic routing is explicit and reversible; once enabled, ordinary compatible editor submissions need no per-message command.

## 15. MVP scope and acceptance criteria

### Deliverables

- Sequential Pi extension for one workspace, with `/orchestrator` management commands.
- Persistent named virtual sessions, descriptive real-session names, and explicit membership.
- Activation of the same virtual session from any eligible real session without importing its history.
- Automatic ordinary-text routing through a decorator of the configured editor factory; no per-message `/route` typing.
- Compatibility gates, disable/restore behavior, explicit bypass, and native command/control preservation.
- Session cards and bounded lexical/recency retrieval within the selected virtual session.
- Pluggable decision adapter with one validated backend.
- Explicit new/reuse overrides and interactive clarification.
- Stable physical worker model configuration.
- Pi automatic compaction plus extension-supported manual compaction.
- Virtual/current-real counts, costs, and token breakdowns in the status UI and detailed report.
- Decision audit log, deduplicated usage ledger, and normalized accounting.
- Replay/evaluation harness and shadow-mode support.

### Behavioral acceptance tests

| Scenario | Required behavior |
| --- | --- |
| “Add tests for that” after a concrete implementation | Reuse the relevant session or clarify if reference is ambiguous |
| Independent task sharing the same keywords | Create a focused session; do not conflate topic with dependency |
| Return to a paused task after unrelated requests | Select the earlier task session without unrelated transcripts |
| Two plausible antecedents | Clarify; do not choose arbitrarily |
| Cross-workspace candidate | Exclude before classifier invocation |
| New-session override | Create fresh context; handoff only under explicit policy |
| Invalid reuse override | Return an error; do not fall back silently |
| Existing session near context limit | Compact safely and preserve required decisions/recent context |
| Compaction failure | Stop or expose a recoverable alternative; no silent context loss |
| Expired provider cache | Resume correct history and report actual usage without assuming a hit |
| Classifier failure or malformed session ID | Apply validated fallback; never open an arbitrary file |
| New request during an active tool sequence | Queue until safe settlement |
| Crash after tools changed files | Mark interrupted and reconcile; no blind replay |
| Stale card or changed session branch | Refresh/reconcile before execution |
| Duplicate request ID | No duplicate session creation or completed execution |
| User corrects assignment | Record correction and use the selected session without deleting history |
| Enable a named virtual session from an unrelated real session | Resume its valid member or await first dispatch; do not import entry history/cost |
| Create/rename virtual sessions with duplicate or blank names | Reject invalid names; preserve immutable IDs and existing membership |
| Automatic ordinary-text submission | Route once; retain original text/history; no internal command appears in worker context |
| Existing custom editor factory | Wrap that factory, preserve documented controls/style, and do not silently replace it |
| Factory callback assigned after creation | Decorated submission still works exactly once |
| Disable orchestration | Restore saved editor factory/draft if still owned; leave current real history intact |
| Another extension replaces the editor | Detect ownership conflict; suspend or cooperate without clobbering the new factory |
| Attachments with no verified safe routing path | Preserve them and block/suggest bypass; never silently discard or misroute them |
| Native commands and active-run steering shortcuts | Preserve Pi behavior; do not route control text as a new task |
| Internal member switch | Preserve active virtual identity and reconstruct fresh editor/UI state |
| External manual switch outside member set | Suspend automatic routing and show resume option; do not implicitly attach |
| Enable virtual session after reload/restart | Registry/name/membership/totals survive; routing requires explicit resume confirmation |
| Group/current-real usage | Show labeled totals without adding a subset twice |
| Pre-existing attached transcript | Exclude pre-attachment usage from group totals; retain real-lifetime diagnostics |
| Retry, compaction, warming, and cloned history | Count actual calls once; copied usage records do not create fictitious expenditure |
| Unknown provider usage/cost | Display incomplete/unknown values rather than zero or invented tokens |

### Evaluation gate

Before enabling automatic routing by default, agree on a labeled evaluation set and explicit quality, latency, and cost targets. Automatic routing must show a measured quality-preserving improvement against the baselines, including all orchestration overhead. Numerical targets remain an open product decision.

## 16. Roadmap

1. **Phase 0 — Compatibility and measurements:** pin Pi version; prototype current-editor factory decoration, callback forwarding, fresh-context dispatch, attachment behavior, and safety preservation; collect baselines and define evaluation data.
2. **Phase 1 — Shadow extension:** `/orchestrator`, named virtual registry, membership/cards, editor decoration, status/usage ledger, classification, and user feedback without automatic switching.
3. **Phase 2 — MVP automation:** creation/reuse/clarification, safe session replacement, editor ownership/reload handling, leases, recovery, accounting, and mandatory context management.
4. **Phase 3 — Economic context management:** proactive compaction, bounded handoffs, and calibrated cache/cost estimates.
5. **Phase 4 — Optional expansion:** physical-model routing, richer retrieval, SDK/RPC host, isolated parallel workers, and multi-workspace deployments.

## 17. Open decisions

- Packaging of the chosen Pi extension: integration into `wpi` or a separate Pi package?
- Which Pi release supports the required editor getter, command contexts, and event/usage contracts?
- Which existing editor extensions are included in the compatibility test matrix?
- Supported attachment capture/dispatch path; is a small upstream Pi API addition required?
- Persistence backend choice and recovery when another process activates the same virtual session?
- UX for user-directed switches between members, explicit bypass, and archived virtual sessions?
- Decision backend: hosted Jev, local Laya, another classifier, or structured-output LLM?
- Privacy policy for hosted routing and summary generation?
- Evaluation corpus and maximum acceptable missed-continuity rate?
- Policy for clarification when no interactive user is available?
- Whether to allow virtual worker models in the MVP or require physical models?
- Session-card and handoff generation model, budgets, and exact limits?
- Archival/search behavior for completed and old sessions?
- Representation of shared project facts without introducing stale or untrusted global memory?

## 18. References

Pi documentation consulted:

- `docs/extensions.md` — command contexts, replacement sessions, UI integration, and lifecycle.
- `docs/tui.md` — editor components, delegation, focus, and keyboard controls.
- Exported `core/extensions/types.d.ts` — `getEditorComponent()`, command context, compaction callbacks, and naming APIs.
- Exported TUI `editor-component.d.ts` — documented editor contract and optional capabilities.
- `examples/extensions/modal-editor.ts` and `handoff.ts` — custom editor and fresh-context new-session patterns.
- `docs/sdk.md` — persistence, lifecycle, and a possible future SDK host.
- `examples/sdk/11-sessions.ts` — create, continue, list, and open sessions.
- `docs/sessions.md` — active branches, session switching, and context behavior.
- `docs/compaction.md` — thresholds, retained boundaries, recovery, and summary hooks.
- `docs/virtual-models.md` — selected versus physical models and sticky dispatch.
- `docs/settings.md` and `docs/models.md` — defaults, cache warming, and cache metadata.

Implementation must verify these contracts against the chosen pinned Pi release.

## 19. Implementation progress — first slice

Implemented in `package/extensions/orchestrator/` against the repository's Pi 0.79.1 APIs without upgrading Pi:

- `/orchestrator` creation, activation, rename, list/status, member selection, explicit attachment, disable, and manual compaction.
- Named virtual metadata and real membership, independently persisted with atomic JSON writes and exclusive mutation/execution locks. SQLite migration remains optional future work.
- Cooperative current-editor factory decoration with late submit-callback interception, receiver-safe delegation, original-text history mapping, and ownership-aware restoration.
- Automatic terminal-text admission through opaque internal commands and fresh-context real-session dispatch.
- Optional explicitly configured Jev/System One HTTP decision adapter; no backend means manual clarification, not automatic paid calls or unvalidated topic guessing.
- Shared secret redaction before direct classifier calls.
- Deduplicated observed usage, membership boundaries, and virtual/current-real status views; missing summary usage and unpriced classifier costs are disclosed as partial.
- Unit and mocked fresh-runtime integration tests plus real Pi extension-loader smoke validation.

Deliberate first-slice limitations:

- Same-member requests currently replace the runtime to obtain an awaited `withSession` delivery context. This can reset private editor state; avoiding repeated replacement needs a supported awaitable current-session path.
- Terminal text and textual attachment references are supported; hidden binary editor attachment buffers and transparent RPC routing are not implemented.
- Native active-run steering stays in the current real session. Additional submissions during routing are retained as process-local drafts, restored across runtime replacement, and recoverable via `/orchestrator drafts`; a durable queued-envelope execution UX is deferred.
- Pi's native automatic compaction is unchanged. Proactive economic compaction, calibrated cache estimates, shadow-mode evaluation, and task-quality gates remain to implement.
- Older Pi transcript formats omit some summary usage. Monetary classifier pricing and exact imported-history provenance are not claimed complete.
- Activation is scoped to the current canonical workspace/user agent directory. Cross-workspace activation and multiple TUI hosts in one process are out of scope.
- Locks coordinate participating orchestrator instances, not arbitrary external transcript writers. Crash recovery is conservative and requires verification before removing stale locks; there is no automatic side-effecting replay.

The extension is experimental and opt-in. See `package/extensions/orchestrator/README.md` for operation and compatibility notes.
