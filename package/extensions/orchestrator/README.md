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

## Optional local/hosted decision model

There are no classifier calls until you explicitly configure an endpoint. The
first request in an empty virtual session does not need classification. Otherwise,
without a backend, the extension asks you to choose a task rather than guessing.

Set these variables in the environment **of the Pi process**:

```bash
export WPI_ORCHESTRATOR_DECISION_URL=http://127.0.0.1:8000/v1/systemone
export WPI_ORCHESTRATOR_DECISION_MODEL=multilingual
```

The endpoint must implement the Jev/System One `state` + typed `questions` protocol,
for example a local Laya server. Authentication, if needed, uses
`WPI_ORCHESTRATOR_DECISION_API_KEY`; never embed credentials in the URL. For Docker,
use the appropriate reachable host/service address and pass the environment
variables into the container. See the [Laya multilingual Docker Compose example](../../../example/laya/README.md)
for a CPU-only Jev-compatible server, test request, and wpi configuration.

Up to three candidates are submitted with session context summaries and usage
metrics. Metrics include lifetime input/output/cache tokens, estimated USD cost,
and completeness flags, including usage before attachment. The active session
uses Pi's live context size/window. Inactive sessions use a last-response token
estimate from the saved leaf branch; their context window is unknown. Missing
usage and post-compaction context estimates remain partial/unknown, not zero.
These metrics are constructed for routing and do not change registry membership.

The classifier is instructed to prioritize task continuity, using context size
and usage only as secondary signals between equally relevant sessions. Historical
cost is not a next-request price: high cumulative usage alone must not cause a
new session or discard needed context. This does not add automatic compaction.

Each summary refreshes
at every `turn_end`, at agent completion, and before routing. It is a bounded,
extractive view of the active branch's latest three user/assistant turns, newest
first; empty assistant messages and tool results are excluded. This adds no model
calls. Routing uses this evolving context rather than the original request;
existing registry `summary` fields remain compatible (the initial goal is only
an empty-summary fallback).

Direct classifier inputs are processed by the bundled shared secret-redaction
helper before being sent. Endpoint configuration is an explicit authorization to
send these session context summaries, usage/context metrics, and the
incoming request to that endpoint; review privacy and retention first.

The highest-scoring choice automatically selects continuation or new work when
its score is **above 60%**, without an additional margin requirement. Scores at or
below 60%, invalid backend responses, over-budget requests, timeouts, and backend failures
retain the current eligible member without user selection. If no eligible current
member exists, dispatch stops and preserves the draft rather than choosing another
session. Without a configured backend, user selection remains available. These scores are **not** calibrated certainty. No physical-model selection or proactive economic
compaction is implemented yet.

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

The checked development API version is Pi **0.79.1**; no Pi dependency upgrade was
made. Other versions/editors need compatibility testing. The extension remains
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
