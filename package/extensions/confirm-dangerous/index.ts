// ============================================================
// confirm-dangerous — Prompt before destructive operations
// ============================================================
// Blocks or confirms potentially dangerous bash commands,
// writes outside allowed paths, and modifications to the pi
// config directory.
//
// Allowed paths outside the workspace:
//   - /tmp            — temporary files (read, write, delete)
//   - /home/pi-user/.pi — pi config directory (mounted from host)
//
// Read operations (read tool) are always allowed — they are
// never dangerous regardless of the target path.
//
// The workspace directory is determined by the WORKSPACE_DIR
// environment variable, set by wpi based on the
// project directory name.
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Workspace directory — set by wpi from the CWD basename
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";

// Paths that are always safe to write to (outside workspace)
const ALLOWED_OUTSIDE_PATHS = [
  "/tmp",                  // temporary files
  "/home/pi-user/.pi",     // pi config directory
];

// Patterns that indicate a dangerous bash command.
// Commands targeting /tmp are exempt from rm patterns.
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)/, description: "Force removal" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s/, description: "Recursive removal" },
  { pattern: /\brm\s+--no-preserve-root/, description: "Root filesystem removal" },
  { pattern: /\bsudo\s+/, description: "Sudo command" },
  { pattern: /\bgit\s+push\s+.*(--force|-f)\b/, description: "Force push" },
  { pattern: /\bgit\s+push\s+.*--delete\b/, description: "Delete remote branch" },
  { pattern: /\bdd\s+/, description: "Low-level disk operation" },
  { pattern: /\bmkfs\b/, description: "Format filesystem" },
  { pattern: /\bmount\b/, description: "Mount filesystem" },
  { pattern: /\bchown\s+/, description: "Change ownership" },
  { pattern: /\bchmod\s+.*[0-7]{3,4}\s+/, description: "Permission change" },
  { pattern: /\bcurl\s+.*\|\s*(sudo\s+)?sh\b/, description: "Pipe curl to shell" },
  { pattern: /\bwget\s+.*\|\s*(sudo\s+)?sh\b/, description: "Pipe wget to shell" },
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // ── Read operations are always safe ──────────────────────
    if (isToolCallEventType("read", event)) {
      return; // always allow
    }

    // ── Bash commands ──────────────────────────────────────
    if (isToolCallEventType("bash", event)) {
      const command: string = event.input.command ?? "";

      for (const { pattern, description } of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          // Allow rm commands that only target /tmp
          if (isTmpRmCommand(command)) {
            return; // safe — removing files in /tmp
          }

          const ok = await ctx.ui.confirm(
            "Dangerous Command",
            `${description}:\n\n${command}\n\nAllow this command?`
          );
          if (!ok) {
            return { block: true, reason: `Blocked: ${description}` };
          }
          return; // Allowed — don't check further patterns
        }
      }
    }

    // ── Write/edit outside workspace ──────────────────────
    if (isToolCallEventType("write", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath) && !isAllowedPath(filePath)) {
        const ok = await ctx.ui.confirm(
          "Write Outside Workspace",
          `Attempting to write to:\n\n${filePath}\n\nThis is outside ${WORKSPACE_DIR}. Allow?`
        );
        if (!ok) {
          return { block: true, reason: `Blocked: write outside ${WORKSPACE_DIR}` };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath) && !isAllowedPath(filePath)) {
        const ok = await ctx.ui.confirm(
          "Edit Outside Workspace",
          `Attempting to edit:\n\n${filePath}\n\nThis is outside ${WORKSPACE_DIR}. Allow?`
        );
        if (!ok) {
          return { block: true, reason: `Blocked: edit outside ${WORKSPACE_DIR}` };
        }
      }
    }
  });
}

// ── Helper functions (exported for testing) ──────────────────

export function isOutsideWorkspace(filePath: string, workspaceDir: string = WORKSPACE_DIR): boolean {
  // Resolve relative paths against the workspace directory
  const normalized = filePath.startsWith("/") ? filePath : `${workspaceDir}/${filePath}`;
  return !normalized.startsWith(`${workspaceDir}/`) && normalized !== workspaceDir;
}

export function isPiConfigDir(filePath: string): boolean {
  // Allow writes to the pi config directory (mounted from host)
  return filePath.startsWith("/home/pi-user/.pi/");
}

export function isTmpPath(filePath: string): boolean {
  // Allow reads/writes/deletes in /tmp
  // Only match absolute /tmp paths — relative paths like "tmp/file"
  // should not be treated as /tmp paths.
  return filePath.startsWith("/tmp/") || filePath === "/tmp";
}

export function isAllowedPath(filePath: string): boolean {
  return isPiConfigDir(filePath) || isTmpPath(filePath);
}

/**
 * Check if a command is an rm-like command that only targets /tmp.
 * These are safe because /tmp is ephemeral and expected to be cleaned up.
 * Returns false for non-rm commands or rm commands that also target
 * paths outside /tmp (including sudo rm, which is always dangerous).
 */
export function isTmpRmCommand(command: string): boolean {
  // sudo rm is always dangerous regardless of target
  if (/^\s*sudo\b/.test(command)) return false;

  // Must be an rm command (rm, rm -r, rm -rf, etc.)
  // Check if ALL path arguments in the command are under /tmp
  const rmMatch = command.match(/\brm\s+(-\w+\s+)*(.+)$/);
  if (!rmMatch) return false;

  const pathPart = rmMatch[2];
  // Split on common separators (spaces, &&, ||, ;, |) and check each token
  // that looks like a path (starts with / or isn't a flag)
  const tokens = pathPart.split(/\s+(?:&&|\|\|)?\s*|\s*;\s*|\s*\|\s*/);
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // Skip flags
    if (trimmed.startsWith("-")) continue;
    // If it's a path and it's not under /tmp, this rm is not limited to /tmp
    if (trimmed.startsWith("/")) {
      if (!isTmpPath(trimmed)) return false;
    } else {
      // Relative path — can't determine if it's /tmp, treat as unsafe
      return false;
    }
  }
  return true;
}

export { DANGEROUS_PATTERNS, WORKSPACE_DIR, ALLOWED_OUTSIDE_PATHS };