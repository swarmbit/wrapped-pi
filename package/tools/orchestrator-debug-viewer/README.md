# Orchestrator decision log viewer

A standalone, local-only browser UI for the orchestrator's decision JSONL logs.
No server, build step, installation, account, or upload is required. Keep
`index.html`, `style.css`, `logs.js`, and `viewer.js` together.

## Open it

1. In Pi, run `/orchestrator debug on` and exercise routing or handoff decisions.
2. Run `/orchestrator debug status` to find the exact log path.
3. Open `package/tools/orchestrator-debug-viewer/index.html` in a modern browser.
4. Choose **Open logs** or drag files onto the drop zone. Select the current
   `.decisions.jsonl` file and any `.1`, `.2`, `.3` rotated backups together.

If Pi runs in Docker, first copy the log files from the container/agent volume to
your host. The browser opens files from the machine where the browser runs.
You may also serve this folder with an existing **loopback-only** static server
if your browser restricts local HTML files. Do not expose the viewer/log folder
on a public interface.

## What it shows

- Newest-first routing and handoff decisions, linked by request ID.
- Text search across requests, session IDs, models, responses, and errors.
- Kind/status filters and measured latency/token summaries for visible matches.
- Overview, backend request, backend response, timeline, and raw-record views.
- Final controller outcomes, probability scores in responses, generated handoffs,
  explicit confirmations, and related dispatch events.
- Unknown metrics as `—`, zero output tokens as `0`, and partial aggregate counts.
- Separate control/dispatch events even when a file contains no decision calls.

TPS is the log's **estimated end-to-end throughput**, not decoder speed. The
non-streaming decision API does not provide time-to-first-token. Server-reported
metrics remain visible in the response/raw views.

## Refresh and limits

**Reload files** re-reads the selected browser File objects; this is a snapshot
viewer, not a live filesystem watcher. Some browsers invalidate a File object
when its underlying file changes or rotates. In that case, use **Open logs** again.
The last successful data stays visible if a reload fails.

Choose at most 20 files totalling 50 MiB. Overlapping snapshots are deduplicated;
malformed/incomplete lines and records over 512 KiB are skipped with a warning.
Lists render the newest 300 filter matches and 100 standalone control/dispatch
events; use filters to narrow large histories. Truncated/incomplete calls are
explicitly marked and do not acquire fabricated token metrics.

## Privacy

Files are read in browser memory only. There are no network calls, analytics,
external assets, or persistent browser storage. **Clear** removes loaded data from
the UI; closing the page also discards it. Log content is rendered as text, never
HTML. A restrictive content-security policy blocks outgoing network connections.

Logs may still contain sensitive task context even after orchestrator redaction.
Use only trusted copies and share carefully. The viewer does not add redaction,
modify the logs, or provide remote access.
