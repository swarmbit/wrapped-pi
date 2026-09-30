# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See partial text, current tool, status, and elapsed time as they happen
- **Parallel and nested progress**: Independent task lanes and nested subagent trees update together
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, reported cost, and context usage per agent; nested costs roll up once
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

The extension is bundled with wpi. To use the sample subagent definitions and prompts, copy or
symlink `package/extensions/subagent/agents/*.md` into `~/.pi/agent/agents/` and
`package/extensions/subagent/prompts/*.md` into `~/.pi/agent/prompts/`. The expert and runner
multiagent definitions are provided separately in `package/extensions/multiagent/agents/`.
The extension itself loads from the bundled package; no extra symlink is needed.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model` (reported so far while running)
- Current tool, elapsed time, and nested agents with their inclusive usage

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel), including nested agents

**Parallel mode streaming**:
- Shows all tasks with live status (· queued, ⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress, including nested subagent tool calls
- Shows "2/3 done, 1 running" status and aggregate reported cost
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

### Expert with runner through multiagent

The expert and runner definitions are maintained under
[`multiagent/agents/`](../multiagent/agents/) for the parent-mediated workflow
provided by the separate [`multiagent` extension](../multiagent/README.md).
Expert requests evidence through `multiagent_parent`, and the parent assigns
explicit tool calls or batches to runner and relays the parsed results. Runner
only executes supplied calls, including exact commands or edit content; it does
not investigate, choose solutions, or implement goals. It uses its parent mailbox
for blockers and transaction results.

Install both definitions from `package/extensions/multiagent/agents/` into the user agent directory. In this repository, select
`/system-prompts multiagent` to use `.pi/system-prompts/multiagent.md`; for other
projects, copy that prompt into `~/.pi/agent/system-prompts/`. This is the new
persistent workflow, not the older `expert-runner` subagent preset.

```json
{"action":"start","agent":"expert","task":"Analyze the failing tests using this evidence: ... Request missing data from the parent and report your recommendation through multiagent_parent."}
```

Invoke that JSON with the `multiagent` tool, not `subagent`. Its managed children
receive `multiagent_parent` automatically, including runner's restricted loadout.
Expert's mailbox-only definition is intended for managed multiagent children;
runner can still return normal responses when used outside this workflow.
These tool lists select model-visible tools; they are not an OS security sandbox.

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Cost during a model response can be zero until the provider reports usage; reported totals may lag actual spend
- Nested agent cost is included in the parent row; do not sum every tree node to calculate the run total
- Children still run in one-shot JSON mode (`--no-session`) and cannot be steered independently yet. See [PLAN.md](PLAN.md) for the RPC interaction milestone.
