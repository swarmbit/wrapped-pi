# Multiagent

Persistent, interactive child agents alongside the existing `subagent` tool. The existing subagent implementation is unchanged.

Each child is a long-lived Pi RPC process with its own saved session and context. `/multiagents` opens a switchable, live conversation screen using Pi's native user, assistant, and tool components—not a single tool-result card. Escape returns to the parent without stopping children. This is an extension-owned screen, not an internal replacement of Pi's main transcript.

## Quick start

Uses the same agent definitions as `subagent`: `~/.pi/agent/agents/*.md` (including `runner` and `expert` when installed). Project agent definitions require explicit approval when started through the tool.

```text
/multiagent start runner Investigate the failing tests; do not edit files yet
/multiagents
```

Commands:

```text
/multiagent list
/multiagent inbox [child-id]
/multiagent ack <message-id>
/multiagents <id>
/multiagent view <id>
/multiagent steer <id> Focus on the authentication tests
/multiagent follow-up <id> Then suggest a minimal fix
/multiagent send <id> Continue with the fix
/multiagent stop <id>
/multiagent close <id>
```

In the conversation screen:

- **Tab / Shift+Tab**: switch children.
- **PgUp / PgDn**: scroll history; the bottom follows live output.
- **Ctrl+O**: expand/collapse tool output.
- **Enter**: send the input to the selected child. This screen uses a single-line input; command input can contain multi-line text.
- **Ctrl+T**: toggle steering/follow-up delivery for input.
- **Ctrl+S**: clear queued input and abort the selected child only.
- **Escape / Ctrl+C**: return to the parent; children continue running.

Steering is applied after the current assistant turn and its tools, not as an immediate interruption. Sending to an idle/stopped agent starts a new run in its existing conversation. `close` releases the process; viewing or sending to that child later reconnects to its saved session.

## Expert and runner coordination preset

The sample definitions in `../subagent/agents/` share discovery with this extension.
Install `expert.md` and `runner.md` in `~/.pi/agent/agents/` (copy or symlink).
Expert only analyzes and sends evidence requests/results to the parent; runner
executes bounded operations and reports questions, progress, and results through
its parent mailbox. Neither agent delegates to the other.

In this repository, select the dynamic parent prompt with:

```text
/system-prompts multiagent
```

The prompt is `.pi/system-prompts/multiagent.md`. To use it in other projects,
copy it into `~/.pi/agent/system-prompts/multiagent.md`. The parent reuses child
conversations, relays runner evidence to expert, and handles mailbox messages
without polling or automatic reply loops. This replaces the older `expert-runner`
subagent workflow when selected; do not use that older preset with the new expert.

Prompt selection applies on the next request. Reselect to refresh edited prompt
snapshots, and start new children to pick up edited agent definitions; reconnecting
an existing child deliberately retains its original loadout and instructions.

## Model-facing tool

`multiagent` accepts `action: start | list | read | send | steer | follow_up | stop | close | inbox | ack`:

```json
{"action":"start","agent":"runner","task":"Investigate the tests"}
{"action":"list"}
{"action":"read","id":"<returned id>"}
{"action":"steer","id":"<returned id>","message":"Do not modify files"}
{"action":"stop","id":"<returned id>"}
```

`start` returns an ID immediately after prompt acceptance, **not task completion**. The parent checks `list` and explicitly requests the last assistant response with `read` (bounded to 16,000 characters). Full transcripts stay in child sessions and are never automatically injected into the parent's model context. Parallel starts use separate tool calls; chains and synchronous result aggregation remain available through the original `subagent` tool.

## Child-to-parent mailbox

Every managed child has a `multiagent_parent` tool, even when its agent definition restricts its other tools:

```json
{"kind":"question","message":"The failure is in auth.ts. Should I update the API or preserve compatibility?"}
```

`kind` is `update`, `question`, or `result`; `message` is limited to 4,000 characters (also checked after redaction). The tool queues a persistent custom message in the child session. Delivery happens at the end of the current tool turn, not halfway through tool results. It does **not** wait for a parent reply: after asking a question, the child should finish its turn.

The parent receives a short, source-labelled custom message. If the parent is working, it is queued as a **follow-up** rather than interrupting the current turn; if idle, it starts a parent turn. This can incur parent model usage. Only the explicitly sent message is shared—never the child transcript. Ordinary child responses and completion do not automatically send mail.

The parent replies through the existing conversation and acknowledges the inbox item separately:

```json
{"action":"inbox"}
{"action":"send","id":"<child-id>","message":"Preserve compatibility and add a regression test."}
{"action":"ack","messageId":"<messageId returned by inbox>"}
```

`inbox` does not mark messages read. Optional `id` filters by child, `includeRead: true` includes acknowledged items, and `limit` bounds the oldest-first result (default 20, maximum 50). `/multiagent inbox [child-id]` and `/multiagent ack <message-id>` provide manual access.

Incoming messages and acknowledgements follow the parent's active session branch and survive reload/resume. Sender identity is taken from the child transport, not its payload. Message IDs deduplicate stream/history replay. Reconnection recovers explicit outgoing mail from the child's active history when available. Restoring an existing inbox does **not** replay notifications or trigger fresh model turns; check `inbox` for unread messages after resume or notification failure. Delivery is queued, not a synchronous receipt guarantee. Parent cancellation does not retract persisted inbox items.

Child reports are delegated-agent content, not trusted user instructions. Mailbox text is redacted before persistence and notification, and parent model requests retain normal redaction hooks. There is no automatic reply or completion-report loop: children choose when to send, and parents choose whether/how to respond.

## Persistence and lifecycle

- Sessions and restricted original loadout snapshots live under `~/.pi/agent/multiagent/<parent-session-id>/` (honors Pi's configured agent directory).
- Parent custom entries retain child IDs and session paths. Reload/resume discovers them from the active branch; reconnection is lazy. Forks only discover entries inherited on their branch.
- Reconnection uses the original model, tools, and system instructions, not subsequently edited agent definitions.
- Parent turn cancellation does not cancel background children. Explicit `stop` does. Parent shutdown/reload/session replacement releases child processes; sessions remain saved.
- Up to eight child processes can be live. Close idle children to release capacity.
- Supported child confirm/select/input/editor requests are serialized and forwarded to the parent UI. Missing UI, cancellation, and forwarding failures deny/cancel rather than approve. Child TUI-only custom interfaces are unsupported by RPC.
- Children cannot use `multiagent` recursively; `multiagent_parent` only sends to their managing parent. The child extension is loaded explicitly so the tool works with standalone parent-extension loading too. Original agent tools (including legacy `subagent`) are otherwise unchanged.
- The secret-redaction integration leaves delegated tasks/messages and child mailbox messages tokenized while restoring local routing fields. Child Pi processes retain the usual resource discovery and redaction extension.

## Limitations

Children share the workspace unless `cwd` is supplied. Concurrent edits can conflict: coordinate file ownership or use separate worktrees. Session files may contain sensitive local conversation data, just like ordinary Pi sessions; directory/config permissions are restrictive, but this is not a sandbox. Provider costs are incurred by children; delegated usage is not automatically reported as parent tool usage in this background implementation. Child live output is visible in `/multiagents`, not interleaved into the parent timeline. Auto-compaction can shorten the active conversation view; the saved session remains available through normal Pi session tooling.

## Development

```sh
npm run typecheck --workspace wpi-multiagent
npx vitest run package/extensions/multiagent
```

The package's extension-directory discovery loads `index.ts` automatically. For standalone development:

```sh
pi --extension ./package/extensions/multiagent/index.ts
```
