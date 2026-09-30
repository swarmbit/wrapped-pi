# Dynamic system prompts

Select reusable Markdown instructions to append to Pi's system prompt, before
starting work or later in the same session. One prompt is active at a time.
This is not a user-message template: the instructions are sent as part of the
system prompt on every subsequent request.

Included automatically in wpi's bundled extension discovery. Rebuild an existing
wpi image to include new extension sources; do not explicitly load a second copy.
Requires Pi 0.99.1+.

## Configure prompts

Add direct `.md` children to either directory:

- **Project:** `.pi/system-prompts/` in the working directory.
- **Personal:** `~/.pi/agent/system-prompts/`, or
  `$PI_CODING_AGENT_DIR/system-prompts/` when that variable is set.

The filename without `.md` is the selection name. Project files override personal
files with the same name. Nested directories and symlinks are not discovered.
`off`, `list`, and `status` are reserved names. Each file must contain nonempty
instructions and be at most 64 KiB. Optional YAML frontmatter supplies a description;
frontmatter is not sent to the model.

For example, `.pi/system-prompts/review.md`:

```markdown
---
description: Review implementation changes for correctness
---
Review changes before making edits. Focus on correctness, regressions, security,
and missing tests. Explain findings with file paths and actionable suggestions.
```

Only explicitly selected files become instructions. Review project prompts before
selecting them: this custom directory is not protected by Pi's native project-trust
resource discovery. Never put credentials in these files.

## Commands

| Command | Behavior |
| --- | --- |
| `/system-prompts` | Open the prompt picker, including an option to disable |
| `/system-prompts <name>` | Select by filename; also works without interactive UI |
| `/system-prompts list` | Show available names and descriptions |
| `/system-prompts status` | Show the active prompt |
| `/system-prompts off` | Stop appending the prompt on future requests |

Changes require an idle agent and apply on the **next request**; selection does not
start a model call. Choose before your first message to use it from the start.
Choosing another prompt replaces the active one. Cancellation leaves it unchanged.
The status line shows the active name.

The selected name, instructions, description, and source are saved as a snapshot
in a custom session entry. Selection survives reload/resume and follows session
branches. Files are reread whenever you open the picker or select by name, with no
reload needed. Select the same name again to refresh an edited file. Removing or
editing its file does not change an existing snapshot.

A new real session starts with no selection. Orchestrator members each have their
own selection; it is not automatically transferred to new members. Disabling or
replacing a prompt affects future requests, not previous messages or instructions
already recorded in the transcript. Changing the system prompt may invalidate
provider prompt caches. Snapshots contain the prompt text: protect session files.

The extension composes with earlier system-prompt handlers and uses the bundled
secret-redaction helper for outbound content. Redaction is best-effort, not a
security boundary.

## Development

```bash
npm run typecheck --workspace wpi-dynamic-system-prompts
npx vitest run package/extensions/dynamic-system-prompts
```
