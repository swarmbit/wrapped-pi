# Subagent visibility and control plan

## Goals

- See what every running subagent is doing, including parallel tasks and subagents it starts.
- See per-agent and aggregate token/cost usage without counting nested work twice.
- Intervene in a specific running agent without disrupting its siblings.

## 1. Live progress and accounting (implemented)

- Represent each invocation as a tree: the tool call owns ordered tasks/steps; a nested `subagent` tool call owns its own ordered children. Keep stable lane IDs even when parallel tasks finish out of order.
- Track queued/running/completed/failed states, current tool, recent output, and elapsed time. Consume Pi's `message_update`, `tool_execution_start/update/end`, and `message_end` JSON events, not just completed messages. Bound text previews and rate-limit rendering updates.
- Count a process's assistant usage once per completed response, using cumulative streaming usage only as an in-flight preview. Add usage reported by its tools once per tool-call ID. Nested subagent tool results will report their aggregate usage so accounting works at arbitrary depth. Sum *root* results for the run total; never sum the tree's parent and child costs again.
- Return aggregate child usage on the subagent tool result so Pi versions that support tool-result usage include delegated work in session totals. For older Pi versions, use the totals in tool details; they still propagate within subagent trees. Provider usage can remain zero until a response ends, so the live display says *reported*, not a hard real-time bill.
- Test single, parallel, queued lanes, chain, nested delegation, out-of-order updates, and prevention of usage double-counting. Keep model-visible final output unchanged.

## 2. Interaction (next milestone)

- Switch each child from one-shot JSON mode to long-lived RPC mode with a writable stdin. Keep each child isolated and address it by invocation/lane ID.
- Offer an interactive `/subagents` view (with command fallbacks) to inspect, steer, send follow-ups, and abort one child. Steering takes effect after its current assistant turn/tools; it is not an immediate pause.
- Forward child `extension_ui_request` dialogs to the parent UI, defaulting to deny on cancellation or missing UI. Preserve signal propagation, process cleanup, and parallel isolation.
- Test input/output framing, simultaneous RPC children, nested routing, and cancellation.

## 3. Guardrails and history

- Add per-run and per-agent soft cost/turn/time budgets, warning before thresholds and stopping at the next safe boundary. Provider usage may be delayed, so a strict dollar cap is not guaranteed.
- Optionally keep restricted, size-bounded per-agent transcripts for later inspection; avoid copying all child output into the parent model context or logging secrets indiscriminately.
