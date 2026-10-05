// ============================================================
// confirm-dangerous — Prompt before destructive operations
// ============================================================
// Blocks or confirms potentially dangerous bash commands and
// writes outside allowed paths. Simple rm commands limited to the
// workspace or /tmp do not require confirmation.
//
// Allowed paths outside the workspace:
//   - /tmp     — temporary files (read, write, delete)
//   - ~/.pi    — pi config directory (mounted from host; also
//                holds the worktree extension's worktrees),
//                except ~/.pi/wpi.yml: wpi reads that file on
//                the host to decide mounts, env, and image
//                build steps, so changing it reaches outside
//                the container
//
// Read operations (read tool) are always allowed — they are
// never dangerous regardless of the target path.
//
// The workspace directory is determined by the WORKSPACE_DIR
// environment variable, set by wpi to the mounted project
// directory.
//
// Write/edit paths are judged the way Pi resolves them ("~",
// "..", relative to the tool's cwd) and after following
// symlinks, so the path the guard approves is the file that
// actually gets written.
// ============================================================

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// Workspace directory — set by wpi to the mounted project directory
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";

// The pi config directory lives under the container user's home. wpi mirrors
// the host identity, so that is the host's home path (e.g. /Users/alice/.pi),
// not a fixed location.
function piConfigDir(): string {
  return path.join(os.homedir(), ".pi");
}

// Paths that are always safe to write to (outside workspace)
const ALLOWED_OUTSIDE_PATHS = [
  "/tmp",          // temporary files
  piConfigDir(),   // pi config directory
];

// Patterns that indicate a dangerous bash command.
// Simple rm commands limited to the workspace or /tmp are exempt.
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\b[^\n;&|]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/, description: "Force removal" },
  { pattern: /\brm\b[^\n;&|]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/, description: "Recursive removal" },
  { pattern: /\brm\b[^\n;&|]*\s--no-preserve-root(?=\s|$)/, description: "Root filesystem removal" },
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

      // Only exempt a standalone rm with verified targets. Other dangerous
      // operations (including sudo and compound commands) still prompt.
      if (isSafeRmCommand(command, WORKSPACE_DIR, ctx.cwd)) return;

      for (const { pattern, description } of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
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
      if (isOutsideWorkspace(filePath, WORKSPACE_DIR, ctx.cwd) && !isAllowedPath(filePath, ctx.cwd)) {
        const ok = await ctx.ui.confirm(
          "Write Outside Workspace",
          `Attempting to write to:\n\n${describeTarget(filePath, ctx.cwd)}\n\nThis is outside ${WORKSPACE_DIR}. Allow?`
        );
        if (!ok) {
          return { block: true, reason: `Blocked: write outside ${WORKSPACE_DIR}` };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (isOutsideWorkspace(filePath, WORKSPACE_DIR, ctx.cwd) && !isAllowedPath(filePath, ctx.cwd)) {
        const ok = await ctx.ui.confirm(
          "Edit Outside Workspace",
          `Attempting to edit:\n\n${describeTarget(filePath, ctx.cwd)}\n\nThis is outside ${WORKSPACE_DIR}. Allow?`
        );
        if (!ok) {
          return { block: true, reason: `Blocked: edit outside ${WORKSPACE_DIR}` };
        }
      }
    }
  });
}

// ── Helper functions (exported for testing) ──────────────────

/** Resolve a file-tool path the way Pi's write/edit tools do, so the guard
 * judges the file that will actually be touched: Unicode spaces become plain
 * spaces, a leading "@" is dropped, "~" expands to the home directory,
 * file:// URLs are accepted, and the rest resolves against the tool's cwd
 * (which also collapses "." and ".." segments).
 */
export function resolveToolPath(filePath: string, cwd: string = WORKSPACE_DIR): string {
  let normalized = filePath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") {
    normalized = os.homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  } else if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Pi rejects a malformed file URL as well; judge the literal text.
    }
  }
  return path.resolve(cwd, normalized);
}

// Follow symlinks through the part of a path that exists. A dangling link
// still decides where a new file would be created, so it is followed too;
// components that do not exist yet cannot redirect anything.
function canonicalize(target: string, depth = 0): string {
  try {
    return realpathSync(target);
  } catch {
    // Not there yet, or a link whose destination is missing.
  }
  if (depth < 40) {
    try {
      if (lstatSync(target).isSymbolicLink()) {
        return canonicalize(path.resolve(path.dirname(target), readlinkSync(target)), depth + 1);
      }
    } catch {
      // Does not exist.
    }
  }
  const parent = path.dirname(target);
  return parent === target ? target : path.join(canonicalize(parent, depth), path.basename(target));
}

function resolvesWithin(filePath: string, cwd: string, directory: string): boolean {
  return isWithin(canonicalize(resolveToolPath(filePath, cwd)), canonicalize(path.resolve(directory)));
}

// Show where the write lands; name the original spelling when it differs.
function describeTarget(filePath: string, cwd: string): string {
  const resolved = canonicalize(resolveToolPath(filePath, cwd));
  return resolved === filePath ? resolved : `${resolved}\n(requested as: ${filePath})`;
}

/** True when a write/edit path lands outside the workspace. Relative paths
 * resolve against `cwd`, the directory the tool call runs in.
 */
export function isOutsideWorkspace(
  filePath: string,
  workspaceDir: string = WORKSPACE_DIR,
  cwd: string = workspaceDir
): boolean {
  return !resolvesWithin(filePath, cwd, workspaceDir);
}

export function isPiConfigDir(filePath: string, cwd: string = WORKSPACE_DIR): boolean {
  // Allow writes to the pi config directory (mounted from host), but not to
  // the launcher config: it is applied on the host at the next start.
  const target = canonicalize(resolveToolPath(filePath, cwd));
  return isWithin(target, canonicalize(piConfigDir())) && target !== canonicalize(path.join(piConfigDir(), "wpi.yml"));
}

export function isTmpPath(filePath: string): boolean {
  // Allow reads/writes/deletes in /tmp
  // Only match absolute /tmp paths — relative paths like "tmp/file"
  // should not be treated as /tmp paths.
  return filePath.startsWith("/tmp/") || filePath === "/tmp";
}

/** True when a write/edit path lands in a location that never needs confirmation. */
export function isAllowedPath(filePath: string, cwd: string = WORKSPACE_DIR): boolean {
  return isPiConfigDir(filePath, cwd) || resolvesWithin(filePath, cwd, "/tmp");
}

/** Allow only a standalone rm whose literal targets are inside the workspace
 * (not the workspace directory itself) or /tmp. Resolve relative paths from
 * the bash tool's cwd; reject shell expansions/compound commands we cannot
 * safely determine targets for.
 */
export function isSafeRmCommand(command: string, workspaceDir: string = WORKSPACE_DIR, cwd: string = workspaceDir): boolean {
  return isRmCommandWithin(command, workspaceDir, cwd, true);
}

// Retain the /tmp-only check for callers that need it.
export function isTmpRmCommand(command: string): boolean {
  return isRmCommandWithin(command, WORKSPACE_DIR, WORKSPACE_DIR, false);
}

function isRmCommandWithin(command: string, workspaceDir: string, cwd: string, allowWorkspace: boolean): boolean {
  const args = parseLiteralRmArgs(command);
  if (!args) return false;

  const workspace = path.resolve(workspaceDir);
  let hasTarget = false;
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && /^-[a-zA-Z]+$/.test(arg)) {
      if (!/^-[rfRvdiI]+$/.test(arg)) return false;
      continue;
    }
    if (!endOfOptions && arg.startsWith("--")) {
      if (!["--force", "--recursive", "--verbose", "--dir"].includes(arg)) return false;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) return false;

    // Don't infer the destination of tilde/variable/command expansions,
    // parent traversal, or globs in directory components.
    if (!arg || arg.startsWith("~") || arg.split("/").includes("..")) return false;
    const parent = path.dirname(arg);
    if (parent.includes("*") || parent.includes("?") || parent.includes("[")) return false;
    const target = path.resolve(cwd, arg);
    const inTmp = isTmpPath(target);
    const inWorkspace = allowWorkspace && target !== workspace && isWithin(target, workspace);
    if (!inTmp && !inWorkspace) return false;
    if (target !== "/tmp" && hasSymlinkParent(target, inTmp ? "/tmp" : workspace)) return false;
    // A trailing slash or /. can dereference a symlink used as the target.
    if (arg.endsWith("/") || /\/\.(?:\/|$)/.test(arg)) {
      try {
        if (lstatSync(target).isSymbolicLink()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    hasTarget = true;
  }
  return hasTarget;
}

function isWithin(target: string, directory: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// A path through a symlinked directory can remove files outside the mount,
// even when its spelling starts with the workspace path.
function hasSymlinkParent(target: string, boundary: string): boolean {
  for (let parent = path.dirname(target); parent !== boundary; parent = path.dirname(parent)) {
    if (parent === path.dirname(parent)) return true;
    try {
      if (lstatSync(parent).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

// A deliberately restricted shell-word parser: no pipelines, redirections,
// substitutions, or additional commands. Quoting and escaped spaces are OK.
function parseLiteralRmArgs(command: string): string[] | null {
  const match = /^rm[ \t]+([^\r\n]+)$/.exec(command.trim());
  if (!match) return null;

  const args: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < match[1].length; i++) {
    const char = match[1][i];
    if (!quote && (char === " " || char === "\t")) {
      if (started) args.push(word);
      word = "";
      started = false;
    } else if (char === "\\" && quote !== "'") {
      if (++i === match[1].length) return null;
      word += match[1][i];
      started = true;
    } else if (char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      started = true;
    } else {
      if (quote !== "'" && (char === "$" || char === "`")) return null;
      if (!quote && (";&|<>(){}".includes(char) || (char === "#" && !started))) return null;
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) args.push(word);
  return args;
}

export { DANGEROUS_PATTERNS, WORKSPACE_DIR, ALLOWED_OUTSIDE_PATHS };