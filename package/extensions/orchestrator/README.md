# Orchestrator (experimental)

A Pi extension that groups focused real Pi sessions under a persistent, named
**virtual session**. Ordinary terminal-editor submissions are routed through a
safe command handler; you do not type `/route` for every message.

This is the first implementation slice, not the complete specification. See
[`docs/multi-session-orchestrator-spec.md`](../../../docs/multi-session-orchestrator-spec.md).

## Start

Included by the bundled package's extension-directory discovery. Rebuild an
existing wpi image/container to pick up new extension sources. For a standalone
local checkout test, load only this extension:

```bash
pi -e ./package/extensions/orchestrator/index.ts
```

Do not load it explicitly if the bundled package already loads it; duplicate
`/orchestrator` commands disable automatic routing.

Inside the Pi terminal:

```text
/orchestrator new "Project Atlas"
Implement OAuth authentication.
Now add tests for that.
```

Creating the virtual session does not adopt the currently open real transcript.
The first request creates a descriptively named real session. Subsequent requests
use an optional decision backend or ask you to choose a member/new session when no backend is configured.
With a backend configured, inconclusive decisions retain the current member without a picker.

```text
/orchestrator on "Project Atlas"
/orchestrator sessions
/orchestrator status
/orchestrator off
```

`on` works from any real session in the same canonical workspace and resumes the
virtual session's last available member. It does not import the entry session.
`off` leaves the current real transcript intact. Startup, `/reload`, and manual
session switches pause automatic routing; explicitly enable it again.

## Commands

Type `/orchestrator ` to see subcommand autocomplete with descriptions, or run
`/orchestrator help` for the full command reference. The `/orchestrator` picker
also offers a help entry.

| Command | Description |
| --- | --- |
| `/orchestrator` | Pick or create a named virtual session, or view help |
| `/orchestrator help` | Show all available commands |
| `/orchestrator new <name>` | Create and enable; names must be unique in the workspace |
| `/orchestrator on <name-or-id>` | Resume and enable an existing virtual session |
| `/orchestrator off` | Disable routing, hide status, and restore the saved editor factory if still owned |
| `/orchestrator list` | List virtual sessions, member counts, and aggregate usage |
| `/orchestrator status` | Counts, detailed virtual/current-real usage, and cost categories |
| `/orchestrator rename <name>` | Rename the selected virtual session without changing identity |
| `/orchestrator delete [name-or-id]` | Delete the named or selected virtual session after confirmation; keep real transcripts |
| `/orchestrator sessions` | Select a named real member |
| `/orchestrator attach [name-or-id]` | Explicitly attach the current unowned real session after confirmation |
| `/orchestrator compact [instructions]` | Run Pi's callback-based manual compaction |
| `/orchestrator debug [on\|off\|status]` | Toggle redacted decision JSONL logs; show state and filesystem path |
| `/orchestrator drafts` | Recover held, unsent text drafts (process-local, never automatically executed) |

Deletion removes the virtual session's membership, usage, and request metadata,
but never deletes real Pi transcript files. Deleting the selected virtual session
pauses routing and restores the editor; pending unsent text remains recoverable
through `/orchestrator drafts`. Other virtual sessions are unchanged. Deletion is
refused while an orchestrator operation holds the workspace execution lease.

Attachment here means **session membership**. Prior usage is excluded from the
virtual aggregate; the real-lifetime view still includes recorded prior usage.
Use `attach <name>` from an unrelated real session when `on <name>` would otherwise
switch you away to an existing member.

Virtual sessions are routing namespaces, not Pi virtual models, merged model
conversations, or inference-provider caches. Each request uses one real session's
context. Group names and totals survive session replacement and process restart.

## Continuous main-chat history

While routing is enabled, the main chat combines the selected virtual session's
member conversations in chronological order. Switching to a different real member
or returning to an earlier task no longer hides the other members' messages.
Pi's native message, streaming, and tool-output renderers remain in use.

This is a display-only projection: no messages are copied into real transcripts or
sent to another member's model context. History is reconstructed from member files
when the chat is rebuilt, including messages before compaction. Only each member's
active branch is displayed; abandoned branches are not merged into the conversation.
Disabling routing restores the current real session's ordinary chat.

Pi has no public main-chat projection API. This feature uses a small,
runtime-local adapter supporting Pi 0.79.1's context renderer and Pi 0.99.1's
entry/item renderer. It is isolated per terminal and detached on disable or
shutdown. On Pi 0.99.1, only full-chat renders are projected; incremental entry
slices (such as compaction updates) retain native rendering to avoid duplicate
history. Unsupported renderer APIs produce a warning and
fall back to real-session chat; unreadable member transcripts also fall back to
native chat with a console diagnostic. Pi upgrades need compatibility testing.

## Optional local/hosted decision model

There are no classifier calls until you explicitly configure an endpoint. The
first request in an empty virtual session does not need routing classification
(but can use the optional new-session model selector below). Otherwise, without a
backend, the extension asks you to choose a task rather than guessing.

Set these variables in the environment **of the Pi process**:

```bash
export WPI_ORCHESTRATOR_DECISION_URL=http://127.0.0.1:8000/v1/systemone
export WPI_ORCHESTRATOR_DECISION_MODEL=english
```

The endpoint must implement the Jev/System One `state` + typed `questions` protocol,
for example a local Laya server. Authentication, if needed, uses
`WPI_ORCHESTRATOR_DECISION_API_KEY`; never embed credentials in the URL. For Docker,
use the appropriate reachable host/service address and pass the environment
variables into the container. See the [Laya English Docker Compose example](../../../example/laya/README.md)
for a CPU-only Jev-compatible server, test request, and wpi configuration.

Up to three candidates are submitted using only their last ten user/assistant
messages, an opaque routing key, a current-session flag, and context-token/window
counts, alongside the incoming request. Session names, original goals, and lifetime
usage/spending are not sent to the routing classifier. Token counts are prompt-cost
proxies, not exact next-request dollar prices; missing counts remain unknown.
Usage accounting remains available locally.

The classifier balances continuity with useful task separation. Dependent follow-ups,
corrections, tests, and refinements normally stay in the current session. Another
member may be chosen when its prior work, decisions, or task focus make it a clearly
better fit, even if the current session could handle the request. NEW is appropriate
for a distinct task that benefits from focused context when no member fits well.
Avoiding long, expensive prompts is an explicit routing priority. For self-contained
work, prefer a suitable shorter member or a new focused session over continuing to
grow a long current session. Among sufficient contexts, favor substantially smaller
prompts, while weighing handoff overhead and cache loss. Topic keywords and sunk
historical spending do not justify switching; dependent work stays or carries its
needed source context through the handoff stage. Tiny savings should not cause churn.
Routing itself does not trigger compaction; model-requested compaction is described below.

Each summary refreshes
at every `turn_end`, at agent completion, and before routing. It is a bounded,
extractive view of the active branch's latest ten nonempty user/assistant messages,
newest first. Full text and tool call names/arguments are retained without character
truncation; tool results, thinking, and image payloads are excluded. Call-only
assistant messages count toward the ten-message limit. Calls indicate attempted
actions, not verified success. This adds no model calls, but full messages can
increase classifier input substantially. Routing uses this evolving context rather
than the original request; existing registry `summary` fields remain compatible.
There is no separate `goal` field or name-based routing fallback. Legacy registry
goals are discarded on read and removed from disk on the next save. These summaries
are separate from Pi compaction summaries and model-generated switch handoffs.

Direct classifier inputs are processed by the bundled shared secret-redaction
helper before being sent. Endpoint configuration is an explicit authorization to
send these recent messages and the incoming request to that endpoint; review privacy and retention first.

Automatic changes require strong scores **and** a wide margin over the runner-up:

- Another existing member: score **at least 80%**, margin **at least 60 percentage points**.
- New real session: score **at least 80%**, margin **at least 60 percentage points**.
- Staying in the current member needs no minimum score.

The controller also enforces these gates for custom decision backends; proposals
without valid `confidence` and `margin` evidence cannot automatically change sessions.
Weak or ambiguous proposals, invalid backend responses, over-budget requests,
timeouts, and backend failures retain the current eligible member. If none exists
and no strongly supported route is available, dispatch stops and preserves the draft.
Without a configured backend, the picker lists the current session first; explicit
user choices can still switch or create a session. The first request in an empty
virtual session creates its first member without routing classification. These scores are
**not** calibrated certainty or proof of task fit.

## Worker model selection at creation

Optionally configure the models the selector may choose in `~/.pi/wpi.yml` or
`.pi/wpi.yml` in the workspace:

```yaml
orchestrator:
  models:
    - model: provider/fast-model
      summary: Simple questions, small edits, and routine tasks.
    - model: provider/strong-model
      summary: Complex implementation, debugging, and architectural reasoning.
```

Use exact Pi `provider/model` IDs (the model ID may itself contain slashes).
Models must already be registered and authenticated in Pi; this configuration
neither registers providers nor supplies credentials. Summaries describe when to
use each model, including any relevant capability, latency, or cost tradeoffs.
A project list **replaces**, not merges, the user list; `models: []` disables selection.
Edits are read before each new member creation. Lists allow up to 32 unique models,
with nonempty summaries of at most 2,000 characters.

After routing chooses NEW, including the first member of an empty virtual session,
a separate question to the configured decision backend selects **only the worker
model**. It does not decide which session to reuse/create or whether a handoff is
needed. The selector's own model remains `WPI_ORCHESTRATOR_DECISION_MODEL`.
Only configured models available in Pi are candidates. The initial request,
up to 12,000 characters of recent source context, current model ID, and model
summaries pass through secret redaction before being sent to the backend.
Requests over 4,000 characters fall back rather than being silently truncated.

The controller requires a score of at least 80% and a margin of at least 60
percentage points. Missing configuration/backend support, invalid configuration,
unknown or unavailable models, ambiguous responses, and network failures retain
the **source session's current model**. The fresh extension runtime applies and
persists the selected or fallback model before the first worker request. If neither
can be applied, delivery is interrupted; an arbitrary model is never substituted.
Pi's native `setModel` also updates its default model setting.

Subsequent requests and resumed sessions use Pi's saved model—no automatic
mid-session or resume-time reselection. Manual Pi model changes remain possible.
Selector usage is recorded separately under the `decision` category, including
ambiguous responses; unreported usage/cost stays unknown.

## Decision debug logging

Use `/orchestrator debug on` to inspect routing, handoff, and new-session model decisions. `debug off`
stops logging immediately (including in-flight calls); `debug status` shows state
and the log path without writing; `debug` alone toggles. These commands also work
while an orchestrator request is running. Debugging is off by default, stays
workspace-scoped across real-session replacements, and resets after process exit.
It changes no prompts, model selection, decision thresholds, or network calls.

Logs are private, append-only JSONL files next to the workspace registry:
`$PI_CODING_AGENT_DIR/orchestrator/<workspace-hash>.decisions.jsonl`
(default agent directory: `~/.pi/agent`). The status command prints the exact path.
Files use mode `0600`, rotate at 10 MiB, and retain three numbered backups. Individual
records are capped at 128 KiB; oversized records retain an explicitly marked,
redacted preview. Oversized HTTP responses rejected by the backend omit their body.

Each decision has a unique `callId`, correlated with the orchestrated `requestId`,
virtual/real session IDs, timestamps, PID, and decision kind. Records include:

- Original request, local candidate summaries/metrics, and handoff preservation notes
  (local debug metadata is distinct from the classifier payload).
- Actual System One request payload (including questions/instructions and model),
  HTTP status, response payload, choices, probabilities, and server-reported metrics.
- Parsed decisions and the controller's final selected/fallback/cancelled outcome.
- Validation failures, timeouts/network errors, explicit handoff confirmations,
  model switch proposals, prepared dispatches, and generated handoff text.
- End-to-end duration, input/output token counts, usage/cost completeness, estimated
  output/total tokens per second, and `timeToFirstTokenMs: null`.

TPS is **end-to-end throughput including network latency**, not measured decoder
speed. System One classification may report zero output tokens; missing counts/rates
remain `null`, not zero. The non-streaming endpoint cannot provide TTFT; any metrics
reported by the server remain available in its recorded response. Custom backends
receive an optional trace callback; without implementing it, only structured
inputs/results and elapsed-time metrics are available. Controller/manual choices
are also recorded and distinguished from backend calls.

Authentication headers and URL query parameters are never recorded. All log data
is passed through the shared secret-redaction helper **before** truncation and
writing. Redaction is best-effort: logs still contain task text/context and should
be shared carefully, retained only as needed, and manually deleted when finished.
Logging failures warn once and never stop routing or dispatch. Symlink/hardlink and
non-regular file targets are rejected rather than followed.

### Browser viewer

Open [`package/tools/orchestrator-debug-viewer/index.html`](../../tools/orchestrator-debug-viewer/index.html)
in a modern browser, then select the current JSONL log and any rotated backups.
The standalone viewer provides decision history, search/filters, request/response
views, correlated timelines, errors, and token/TPS summaries. It reads files in
browser memory without uploads or a server. For Docker logs, copy them to the host
first. See the [viewer guide](../../tools/orchestrator-debug-viewer/README.md) for
refresh behavior, limits, and privacy notes.

## Session switches and handoffs

Both classifier-selected switches and model-requested switches use the same
handoff stage **before replacing the source runtime**. The configured System One
decision model receives the original request, bounded source/destination context
summaries, source/destination context-token counts, switch reason, and any
model-supplied preservation notes. It weighs handoff generation, added destination
tokens, and future prompt cost: self-contained or redundant context gets no handoff;
necessary source-only facts get the smallest useful handoff, not the entire history.
A long destination calls for minimizing context, never dropping indispensable facts.
It answers a
separate `handoff` choice question (`NEEDED` or `NOT_NEEDED`); automatic acceptance
requires at least 80% score and a 60-percentage-point margin. The session model's
notes never bypass this decision.

When needed, the **source session's configured model** writes a bounded handoff
through a separate tool-free registry call. Its recent transcript text and latest
compaction summary are supplied as context; its conversation is not changed. The
destination receives the original user request verbatim, followed by explicitly
labelled supporting context. When no handoff is needed, the original request is
sent unchanged. Staying in the same real session and the first request from an
empty source skip this stage.

No backend, unsupported custom backends, ambiguous/invalid responses, timeouts,
or failed/empty/truncated handoff generation hold the switch for explicit user
confirmation. You may cancel (restoring the original draft), provide bounded
handoff text, or explicitly proceed without a handoff. No silent context-dropping
fallback is used. Handoff decisions count as `decision` usage; generation counts
as `summary` usage. Structured outbound decision inputs, source excerpts, and
handoff text are secret-redacted. Endpoint configuration therefore also authorizes
sending this handoff-decision data to that server; generation uses the source
model's provider. Failed attempted calls retain unknown/partial usage.

On **Pi 0.99.1+**, `request_session_switch` allows the session model to propose an
existing real member of the enabled virtual session using `target_session_id`,
`reason`, and `preservation_notes`. A bounded request-local member list exposes IDs
and summaries without changing the system prompt. The tool cannot create sessions
or select members of another virtual session. Switching should favor a clearly
better-fitting task context, not merely save tokens or match keywords.

The tool returns **scheduled** and waits for final settlement and idle state before
using Pi's supported command-dispatch bridge (`expandPromptTemplates: true`) to
enter the existing command-capable dispatcher. It never switches during tool
execution. The target receives the original request and any required handoff,
using its own model and context, without another routing classification. Only one
model-requested switch is allowed per user submission to prevent ping-pong.
Pending switches and compaction requests are mutually exclusive. New input,
queued input, shutdown, session changes, tree navigation, or compaction cancel
pending switches. Requests are process-local and do not survive reload. Source
model generation and the deferred switch tool require Pi 0.99.1+; older Pi can
still route, but requires manual handoff input/confirmation when generation is
needed.

## Model-requested compaction

With routing enabled for the current member session on **Pi 0.99.1+**, the
`request_compaction` tool lets the session's own model request compaction at a
safe milestone. It supplies a reason and preservation notes. There is no separate
classifier/model call and no forced extra turn for the decision.

The extension adds a request-local review reminder every **10 completed model
turns** (an assistant response plus its tool results, not necessarily 10 user
messages), once the known context estimate reaches **30,000 tokens**. Configure
these positive-integer limits in the Pi process environment:

```bash
export WPI_ORCHESTRATOR_COMPACT_TURNS=10
export WPI_ORCHESTRATOR_COMPACT_MIN_TOKENS=30000
```

The model should consider completed milestones, information loss, remaining work,
summarization cost, and cache invalidation. Savings are not guaranteed. Reviews
are opportunities to decline compaction, not mandatory compaction intervals.
Unknown context size, small context, and too few turns since the last compaction
block requests. The turn interval also provides a post-compaction cooldown.

The tool returns **scheduled**, not **completed**. It never compacts inside tool
execution, where Pi's abort-and-wait behavior could deadlock the running tool.
After `agent_settled`, the extension yields out of the notification handler and
rechecks idle state, session identity, membership, and queued input before calling
Pi's native compaction. Tool calls/results and the final assistant response are
recorded first. It does not automatically resume or generate another response.
New user input, shutdown, session changes, tree navigation, or another compaction
cancel pending requests. Success/failure is reported separately through UI
notifications; failed requests are not automatically retried. Pending requests
are process-local and are not restored after reload.

Pi 0.79.1 lacks a safe final-settlement event: reviews/model-requested compaction
are disabled there rather than treating `agent_end` as final. The existing
`/orchestrator compact [instructions]` command remains available. Native Pi
context-overflow/automatic compaction settings remain independent of this feature.

## Editor compatibility

The extension uses `getEditorComponent()` to wrap the configured factory, or Pi's
`CustomEditor` when the default editor is in use. Its proxy delegates methods with
the original receiver, forwards optional capabilities/control callbacks, and
intercepts host-assigned submission callbacks even when they are assigned after
factory creation. It does not globally capture Enter or replace modal editing.

- Slash commands, shell commands, and native in-flight steering/follow-up behavior
  retain normal Pi semantics. Skill/template commands also bypass automatic routing.
- Internal dispatch transports an opaque request reference; your original text is
  used in history and delivered once, without transport commands in worker context.
- Another editor extension taking ownership is not clobbered on disable.
- The status widget is keyed; existing footer/header/editor providers are retained.
- The factory API does not expose the live editor. Activation and session replacement
  recreate it; private undo/history/cursor/modal state may not survive.
- **Current limitation:** even same-member reuse replaces the Pi runtime to obtain a
  fresh, awaited delivery context. Eliminating that reload requires a supported
  awaitable current-session dispatch path, not a stale-context workaround.
- This slice supports terminal **text** submissions, including textual file/image
  references emitted by the tested Pi editor. It does not capture hidden binary
  attachment buffers or transparently route RPC/programmatic inputs. Do not use it
  with a custom editor that hides attachment state without validating a safe adapter.
- While routing itself is busy, another idle submission is retained as an unsent
  draft, not sent to an unrelated session. The latest is restored after replacement;
  `/orchestrator drafts` can recover the others. These drafts are process-local, not
  durable across process exits. A full cross-session execution queue is deferred.

The checked development API version is Pi **0.99.1**. The history adapter
supports the Pi **0.79.1** context renderer and Pi **0.99.1** renderer API.
Other versions/editors need compatibility testing. The extension remains
opt-in until `/orchestrator` enables routing.

## Usage and persistence

The info widget shows one line only while routing is enabled:
`<name> · V ~$0.2500 ↑10 ↓2 R100 · R ~$0.2500 ↑10 ↓2 R100`.
V is the selected virtual session's total usage; R is the active real
session's lifetime usage, including usage before attachment. Each section uses
Pi-style token counters: ↑ input, ↓ output, R cache reads, W cache writes.
Zero counters are omitted and large counts use k/M abbreviations; missing token
data is marked partial. There is no duplicate
footer status. Disabling or pausing routing hides the widget.

`/orchestrator status` remains available for a detailed report, including session
counts, current real name/context size, token breakdowns, and cost categories.
These cumulative usage figures are not current context size. The current real
total overlaps the virtual total, **not** an extra cost to add to it.

The ledger deduplicates copied entry identities and includes observed worker/tool
usage, summary usage, warming, and classifier overhead. Older Pi releases do not
persist all summary usage: those gaps are marked partial. Classifier monetary cost
is currently unpriced, and reported worker/catalog costs are estimates rather than
subscription invoices. Missing data is not presented as a complete zero-cost total.

For this slice, metadata uses locked, atomic JSON rather than the proposed SQLite:

```text
<agent-dir>/orchestrator/<canonical-workspace-sha256>.json
```

Files are created with mode `0600`, directories with `0700`. Registry writes use a
short mutation lock; dispatch holds a workspace execution lease through its awaited
worker run. Contention fails closed. An abrupt process exit can leave `.lock` or
`.execution` files: verify the owning process is stopped before manually removing
one. Never remove a live process's lease. Arbitrary external tools or Pi instances
without this extension are not forced to honor these locks.

Registry session context summaries contain conversation text and can contain sensitive local data; protect
backups like transcripts. Do not hand-edit membership boundaries or usage IDs.
Interrupted requests are not replayed automatically: inspect the real transcript
and workspace because tools may already have made changes.

## Tests

```bash
npx tsc --noEmit -p package/extensions/orchestrator/tsconfig.json
npx vitest run package/extensions/orchestrator
npm test
```

Tests cover registry persistence/locking, usage normalization and deduplication,
decision response validation, editor delegation, fresh-context session replacement,
resume from unrelated sessions, cancellation, and explicit session attachment.
Real loader smoke tests complement mocked UI integration; a live terminal and
chosen classifier still require manual end-to-end testing.
