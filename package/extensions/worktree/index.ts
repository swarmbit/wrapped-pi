// ============================================================
// worktree — Git worktree management extension
// ============================================================
// Supports creating, listing, and deleting git worktrees.
// Each worktree lives under ~/.pi/worktrees/<encoded-cwd>/
// and has a dedicated pi session rooted at the worktree directory.
//
// Worktrees and sessions are decoupled — the registry only tracks
// worktree metadata. Sessions are managed independently by pi's
// session manager.
//
// Commands:
//   /worktree:create <name>           Create worktree and open a new session on it
//   /worktree:open                    Interactively select and open a new session on it
//   /worktree:close                   Open a new session on the project directory
//   /worktree:delete                  Interactively select and delete a worktree and associated session
//   /worktree:sync                    Merge base branch into the worktree
//   /worktree:accept                  Merge worktree changes back into the base branch
//
// Registry:
//   ~/.pi/worktrees/<encoded-cwd>/registry.json
//   Maps worktree name -> { path, createdAt, baseRef }
// ============================================================

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { writeFileSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";


// ── Logging ──────────────────────────────────────────────────

const LOG_FILE = path.join(os.homedir(), ".pi", "worktree.log");

let _logToFile = true;

function log(msg: string): void {
  if (_logToFile) {
    try {
      const dir = path.dirname(LOG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString();
      fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
    } catch {
      // best-effort
    }
  } else {
    console.log(`[worktree] ${msg}`);
  }
}

/** Set whether logs go to file (true) or console (false, default). */
export function setWorktreeLogToFile(enabled: boolean): void {
  _logToFile = enabled;
}

// ── Host path resolution ───────────────────────────────────

/**
 * Convert a container path to the corresponding host path.
 *
 * Inside the container, ~/.pi is volume-mounted from the host's ~/.pi
 * (or wherever the host config dir is). PI_HOST_HOME is set by wpi
 * at container startup and points to the host user's home directory.
 *
 * Returns undefined if PI_HOST_HOME is not set (e.g. running outside a container).
 */
function containerToHostPath(containerPath: string): string | undefined {
  const hostHome = process.env.PI_HOST_HOME;
  if (!hostHome) return undefined;

  const containerHome = os.homedir(); // /home/pi-user
  if (containerPath.startsWith(containerHome + path.sep)) {
    return path.join(hostHome, containerPath.slice(containerHome.length));
  }

  // If the path doesn't start with the container home, return as-is
  // (shouldn't happen for worktree paths, but be safe)
  return containerPath;
}

// ── Path helpers ────────────────────────────────────────────

/** Top-level worktrees directory in the user's home. */
export function getWorktreeHomeDir(): string {
  return path.resolve(os.homedir(), ".pi", "worktrees");
}

/**
 * Encode a cwd into a safe directory name, matching the scheme
 * used by pi's session manager for session directories.
 */
function encodeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Per-project directory for worktrees registered from a given cwd. */
export function getWorktreeProjectDir(cwd: string): string {
  return path.join(getWorktreeHomeDir(), encodeCwd(cwd));
}

/** Registry file for a project. Automatically normalizes cwd —
 * if the cwd is inside a worktree, resolves to the parent project dir. */
export function getRegistryPath(cwd: string): string {
  return path.join(getWorktreeProjectDir(cwd), "registry.json");
}

/** Check if a cwd is inside a worktree directory. */
function isInsideWorktree(cwd: string): boolean {
  return path.resolve(cwd).startsWith(getWorktreeHomeDir() + path.sep);
}

/** Derive the project directory that owns a given cwd.
 * If cwd is inside ~/.pi/worktrees/<project>/..., returns <project>.
 * Otherwise returns getWorktreeProjectDir(cwd). */
function resolveProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const homeDir = getWorktreeHomeDir();
  if (resolved.startsWith(homeDir + path.sep)) {
    const relative = resolved.slice(homeDir.length + 1);
    const encoded = relative.split(path.sep)[0];
    const projectDir = path.join(homeDir, encoded);
    if (fs.existsSync(path.join(projectDir, "registry.json"))) {
      return projectDir;
    }
  }
  return getWorktreeProjectDir(cwd);
}

/** Derive the original project cwd from a potentially-worktree cwd,
 * using the first worktree entry's originalCwd as a hint. */
function resolveProjectCwd(ctxCwd: string): string {
  const projectDir = resolveProjectDir(ctxCwd);
  const registry = readRegistryFromDir(projectDir);
  for (const entry of Object.values(registry.worktrees)) {
    if (entry.originalCwd) return entry.originalCwd;
  }
  return ctxCwd;
}

function readRegistryFromDir(projectDir: string): Registry {
  const registryPath = path.join(projectDir, "registry.json");
  try {
    const raw = fs.readFileSync(registryPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { worktrees: {} };
  }
}

function writeRegistryToDir(projectDir: string, registry: Registry): void {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
}

/** Full path to a specific worktree on disk. */
export function getWorktreePath(cwd: string, worktreeName: string): string {
  return path.join(getWorktreeProjectDir(cwd), worktreeName);
}

// ── Git helpers ──────────────────────────────────────────────

export function getCurrentBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "HEAD";
  }
}

export function getShortHash(ref: string = "HEAD"): string {
  try {
    return execSync(`git rev-parse --short ${ref}`, { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildWorktreeName(shortHash: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${safe}-${shortHash}`;
}

// ── Registry ────────────────────────────────────────────────

export interface WorktreeEntry {
  /** Full absolute path to the git worktree on disk. */
  path: string;
  createdAt: string;
  baseRef: string;
  /** The cwd where the worktree was created from. */
  originalCwd: string;
}

export interface Registry {
  worktrees: Record<string, WorktreeEntry>;
}

export function readRegistry(cwd: string): Registry {
  return readRegistryFromDir(resolveProjectDir(cwd));
}

export function writeRegistry(cwd: string, registry: Registry): void {
  writeRegistryToDir(resolveProjectDir(cwd), registry);
}

// ── Core logic ───────────────────────────────────────────────

export interface CreateResult {
  error?: string;
  worktreeName?: string;
  worktreePath?: string;
}

async function createNewSession(ctx: ExtensionCommandContext, cwd: string) {
  const sm = SessionManager.create(cwd);
  const sessionHeader = sm.getHeader();
  const sessionFilePath = sm.getSessionFile() ?? "";

  // Manually write the session file
  // If we don't write the session file at this state it will use the wrong cwd
  writeFileSync(sessionFilePath, JSON.stringify(sessionHeader) + "\n");

  await ctx.switchSession(sessionFilePath, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(
        `You are now on directory: ` + cwd,
        "info"
      );
    },
  });
}

export async function createWorktree(
  pi: ExtensionAPI,
  ctx:  ExtensionCommandContext,
  name: string,
  base?: string
): Promise<CreateResult> {
  // Use the original project cwd for path and registry lookups,
  // even if the current session is inside a worktree.
  const projectCwd = resolveProjectCwd(ctx.cwd);
  try {
    execSync("git rev-parse --git-dir", { encoding: "utf-8", stdio: "pipe" });
  } catch {
    return { error: "Not a git repository. Initialize git first." };
  }

  const baseRef = base ?? getCurrentBranch();
  const shortHash = getShortHash(baseRef);
  const worktreeName = buildWorktreeName(shortHash, name);
  const worktreePath = getWorktreePath(ctx.cwd, worktreeName);

  log(`createWorktree: name=${name} base=${baseRef} worktreeName=${worktreeName} cwd=${ctx.cwd} path=${worktreePath}`);

  // Check if already exists on disk
  if (fs.existsSync(worktreePath)) {
    return { error: `Worktree path already exists: ${worktreePath}` };
  }

  // Check if already registered
  const registry = readRegistry(ctx.cwd);
  if (registry.worktrees[worktreeName]) {
    return { error: `Worktree "${worktreeName}" already registered.` };
  }

  // Create the git worktree
  log(`createWorktree: git worktree add -b ${worktreeName} ${worktreePath} ${baseRef}`);
  const addResult = await pi.exec("git", [
    "worktree", "add", "-b", worktreeName, worktreePath, baseRef,
  ]);

  if (addResult.code !== 0) {
    log(`createWorktree: git worktree add FAILED: ${addResult.stderr || addResult.stdout}`);
    const stderr = (addResult.stderr || "").toLowerCase();
    if (stderr.includes("already exists")) {
      return {
        error: `A branch named "${worktreeName}" already exists. ` +
          `Use a different worktree name.`,
      };
    }
    return { error: `git worktree add failed: ${addResult.stderr || addResult.stdout}` };
  }

  // Register
  registry.worktrees[worktreeName] = {
    path: worktreePath,
    createdAt: new Date().toISOString(),
    baseRef,
    originalCwd: projectCwd,
  };
  writeRegistry(projectCwd, registry);
  log(`createWorktree: registry updated for ${worktreeName}`);

  return { worktreeName, worktreePath };
}

// ── Delete worktree ────────────────────────────────────────

export interface DeleteResult {
  error?: string;
  deletedSessions?: number;
}

export interface DeleteWorktreeOptions {
  /** Whether to also delete sessions whose header cwd is the worktree path. Default: true. */
  deleteSessions?: boolean;
}

export async function deleteWorktree(
  pi: ExtensionAPI,
  ctx: any,
  worktreeName: string,
  options?: DeleteWorktreeOptions
): Promise<DeleteResult> {
  const deleteSessions = options?.deleteSessions ?? true;
  let deletedSessions = 0;

  log(`deleteWorktree: name=${worktreeName} deleteSessions=${deleteSessions}`);

  // Use the original cwd from the registry for path resolution,
  // since the current cwd may be different (e.g. inside a worktree).
  // Look up the worktree first to get its originalCwd.
  const registry = readRegistry(ctx.cwd);
  const entry = registry.worktrees[worktreeName];

  if (!entry) {
    log(`deleteWorktree: not found in registry`);
    return { error: `Worktree "${worktreeName}" not found in registry.` };
  }

  // Refuse to delete the worktree the current session is in
  const currentCwd = ctx.sessionManager.getCwd();
  if (currentCwd && currentCwd === entry.path) {
    return {
      error:
        `Cannot delete worktree "${worktreeName}" while your session is inside it. ` +
        `Switch to a different session first.`,
    };
  }

  // Remove the git worktree (deletes directory and files)
  log(`deleteWorktree: removing git worktree ${entry.path}`);
  const removeResult = await pi.exec("git", ["worktree", "remove", "--force", entry.path]);
  if (removeResult.code !== 0) {
    log(`deleteWorktree: git remove FAILED: ${removeResult.stderr || removeResult.stdout}`);
    if (!fs.existsSync(entry.path)) {
      log(`deleteWorktree: directory missing, pruning`);
      await pi.exec("git", ["worktree", "prune"]);
    } else {
      return {
        error: `git worktree remove failed: ${removeResult.stderr || removeResult.stdout}`,
      };
    }
  }

  // Delete the associated branch
  log(`deleteWorktree: deleting branch ${worktreeName}`);
  const branchDeleteResult = await pi.exec("git", ["-C", entry.originalCwd, "branch", "-d", worktreeName]);
  if (branchDeleteResult.code !== 0) {
    log(`deleteWorktree: git branch -d FAILED: ${branchDeleteResult.stderr || branchDeleteResult.stdout}`);
    const combined = ((branchDeleteResult.stderr || "") + (branchDeleteResult.stdout || "")).toLowerCase();
    if (combined.includes("not fully merged")) {
      const forceDelete = await ctx.ui.confirm(
        "Branch Not Merged",
        `Branch "${worktreeName}" is not fully merged. Force delete with "git branch -D"?`
      );
      if (forceDelete) {
        log(`deleteWorktree: force deleting branch ${worktreeName}`);
        await pi.exec("git", ["-C", entry.originalCwd, "branch", "-D", worktreeName]);
      } else {
        log(`deleteWorktree: user chose not to force delete branch ${worktreeName}`);
      }
    }
    // For other failures (e.g. branch already deleted), proceed silently
  }

  // Delete sessions whose header cwd matches the worktree path
  if (deleteSessions) {
    try {
      const sessions = await SessionManager.list(entry.path);
      log(`deleteWorktree: found ${sessions.length} session(s) for worktree cwd ${entry.path}`);
      for (const session of sessions) {
        try {
          unlinkSync(session.path);
          deletedSessions++;
          log(`deleteWorktree: deleted session ${session.path}`);
        } catch (err: any) {
          log(`deleteWorktree: failed to delete session ${session.path}: ${err.message ?? String(err)}`);
        }
      }

      // Clean up empty session directory
      try {
        const sessionDir = path.dirname(sessions[0]?.path ?? "");
        if (sessionDir && fs.existsSync(sessionDir)) {
          const remaining = readdirSync(sessionDir).filter((n) => !n.startsWith("."));
          if (remaining.length === 0) {
            rmdirSync(sessionDir);
            log(`deleteWorktree: removed empty session dir ${sessionDir}`);
          }
        }
      } catch (err: any) {
        log(`deleteWorktree: session dir cleanup warning: ${err.message ?? String(err)}`);
      }
    } catch (err: any) {
      log(`deleteWorktree: session listing/deletion warning: ${err.message ?? String(err)}`);
    }
  }

  // Update registry
  delete registry.worktrees[worktreeName];
  writeRegistry(ctx.cwd, registry);
  log(`deleteWorktree: registry updated, worktree ${worktreeName} removed`);

  // Clean up empty project directory
  const projectDir = resolveProjectDir(ctx.cwd);
  const remaining = Object.keys(registry.worktrees).length;
  if (remaining === 0) {
    try {
      const registryPath = path.join(projectDir, "registry.json");
      if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
      fs.rmdirSync(projectDir);
      log(`deleteWorktree: removed empty project dir ${projectDir}`);

      // Also remove the top-level worktrees dir if empty
      const homeDir = getWorktreeHomeDir();
      const homeEntries = fs.readdirSync(homeDir).filter((n) => !n.startsWith("."));
      if (homeEntries.length === 0) {
        fs.rmdirSync(homeDir);
        log(`deleteWorktree: removed empty worktrees dir ${homeDir}`);
      }
    } catch (err: any) {
      log(`deleteWorktree: cleanup warning: ${err.message ?? String(err)}`);
    }
  }

  return { deletedSessions };
}

// ── Extension entry point ────────────────────────────────────

export default function (pi: ExtensionAPI) {

  pi.registerCommand("worktree:create", {
    description: "Create a worktree and a new session on it: /worktree:create <name>",
    handler: async (args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Cannot create a worktree from inside a worktree. Use /worktree:close first.", "error");
        return;
      }

      const name = (args ?? "").trim().split(/\s+/)[0];

      if (!name) {
        ctx.ui.notify("Usage: /worktree:create <name>", "error");
        return;
      }

      // Check if worktree already exists
      const shortHash = getShortHash(getCurrentBranch());
      const worktreeName = buildWorktreeName(shortHash, name);
      const registry = readRegistry(ctx.cwd);

      const worktree = registry.worktrees[worktreeName]
      if (!worktree) {
        const result = await createWorktree(pi, ctx, name);
        if (result.error) {
          ctx.ui.notify(result.error, "error");
          return;
        }
        await createNewSession(ctx, result.worktreePath ?? "")
      } else {
        await createNewSession(ctx, worktree.path ?? "")
      }

    },
  });

  pi.registerCommand("worktree:open", {
    description: "Select a worktree and open a new session on it",
    handler: async (_args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Already in a worktree. Use /worktree:close first.", "error");
        return;
      }

      const registry = readRegistry(ctx.cwd);
      const names = Object.keys(registry.worktrees);

      if (names.length === 0) {
        ctx.ui.notify("No worktrees available. Use /worktree:create <name> first.", "info");
        return;
      }

      const choice = await ctx.ui.select(
        "Select worktree to open:",
        names.map((n) => {
          const e = registry.worktrees[n];
          return `${n}  (${e.baseRef})`;
        })
      );

      if (!choice) {
        ctx.ui.notify("Open cancelled.", "info");
        return;
      }

      const worktreeName = choice.split("  ")[0];
      const entry = registry.worktrees[worktreeName];

      if (!entry) {
        ctx.ui.notify(`Worktree "${worktreeName}" not found`, "info");
        return;
      }
      
      await createNewSession(ctx, entry.path);

    },
  });

  pi.registerCommand("worktree:delete", {
    description: "Interactively select and delete a worktree and associated sessions",
    handler: async (_args, ctx) => {
      if (isInsideWorktree(ctx.cwd)) {
        ctx.ui.notify("Cannot delete worktrees from inside a worktree. Use /worktree:close first.", "error");
        return;
      }

      const registry = readRegistry(ctx.cwd);
      const currentCwd = ctx.sessionManager.getCwd();

      // Filter out worktrees matching the current session cwd
      const names = Object.keys(registry.worktrees).filter((n) => {
        const entry = registry.worktrees[n];
        return currentCwd !== entry.path;
      });

      if (names.length === 0) {
        ctx.ui.notify("No worktrees available to delete.", "info");
        return;
      }

      const choice = await ctx.ui.select(
        "Select worktree to delete:",
        names.map((n) => {
          const e = registry.worktrees[n];
          return `${n}  (${e.baseRef})`;
        })
      );

      if (!choice) {
        ctx.ui.notify("Delete cancelled.", "info");
        return;
      }

      const worktreeName = choice.split("  ")[0];
      const entry = registry.worktrees[worktreeName];

      // Check for associated sessions and ask whether to delete them
      let deleteSessions = true;
      if (entry) {
        try {
          const sessions = await SessionManager.list(entry.path);
          if (sessions.length > 0) {
            const sessionWord = sessions.length === 1 ? "session" : "sessions";
            deleteSessions = await ctx.ui.confirm(
              "Delete Associated Sessions",
              `This worktree has ${sessions.length} ${sessionWord}. Delete them too?\n\nSelecting "No" will keep sessions but delete the worktree.`
            );
          }
        } catch {
          // If session listing fails, proceed with session deletion skipped
          deleteSessions = false;
        }
      }

      const result = await deleteWorktree(pi, ctx, worktreeName, { deleteSessions });
      if (result.error) {
        ctx.ui.notify(result.error, "error");
        return;
      }

      const sessionMsg = result.deletedSessions
        ? ` and ${result.deletedSessions} session(s)`
        : "";
      ctx.ui.notify(`Worktree "${worktreeName}" deleted${sessionMsg}.`, "info");
    },
  });

  pi.registerCommand("worktree:sync", {
    description: "Merge the base branch into the current worktree",
    handler: async (_args, ctx) => {
      const currentCwd = ctx.sessionManager.getCwd();

      if (!isInsideWorktree(currentCwd)) {
        ctx.ui.notify("Not inside a worktree. Use /worktree:open first.", "error");
        return;
      }

      const registry = readRegistry(ctx.cwd);

      // Find the worktree matching the current cwd
      let baseRef: string | undefined;
      for (const entry of Object.values(registry.worktrees)) {
        if (entry.path === currentCwd) {
          baseRef = entry.baseRef;
          break;
        }
      }

      if (!baseRef) {
        ctx.ui.notify("Could not find worktree entry for current session.", "error");
        return;
      }

      log(`worktree:sync: merging ${baseRef} into current branch`);
      const result = await pi.exec("git", ["merge", baseRef]);

      if (result.code !== 0) {
        const output = result.stderr || result.stdout || "merge failed";
        ctx.ui.notify(`Merge failed: ${output.slice(0, 200)}`, "error");
        return;
      }

      const msg = (result.stdout || "").trim();
      if (msg.toLowerCase().includes("already up to date")) {
        ctx.ui.notify(`Already up to date with ${baseRef}.`, "info");
      } else {
        ctx.ui.notify(`Merged ${baseRef} into current branch.`, "info");
      }
    },
  });

  pi.registerCommand("worktree:accept", {
    description: "Merge worktree changes back into the base branch",
    handler: async (_args, ctx) => {
      const currentCwd = ctx.sessionManager.getCwd();

      if (!isInsideWorktree(currentCwd)) {
        ctx.ui.notify("Not inside a worktree. Use /worktree:open first.", "error");
        return;
      }

      const registry = readRegistry(ctx.cwd);

      // Find the worktree matching the current cwd
      let worktreeEntry: WorktreeEntry | undefined;
      let worktreeName: string | undefined;
      for (const [name, entry] of Object.entries(registry.worktrees)) {
        if (entry.path === currentCwd) {
          worktreeEntry = entry;
          worktreeName = name;
          break;
        }
      }

      if (!worktreeEntry || !worktreeName) {
        ctx.ui.notify("Could not find worktree entry for current session.", "error");
        return;
      }

      const originalCwd = worktreeEntry.originalCwd;
      const baseRef = worktreeEntry.baseRef;

      log(`worktree:accept: merging ${worktreeName} into ${baseRef} in ${originalCwd}`);

      // Ensure the base branch is checked out in the original project
      const branchResult = await pi.exec("git", ["-C", originalCwd, "rev-parse", "--abbrev-ref", "HEAD"]);
      const currentBranch = (branchResult.stdout || "").trim();

      if (currentBranch !== baseRef) {
        log(`worktree:accept: ${baseRef} not checked out (current is ${currentBranch}), checking out`);
        const checkoutResult = await pi.exec("git", ["-C", originalCwd, "checkout", baseRef]);
        if (checkoutResult.code !== 0) {
          const err = checkoutResult.stderr || checkoutResult.stdout || "checkout failed";
          ctx.ui.notify(`Could not checkout ${baseRef}: ${err.slice(0, 200)}`, "error");
          return;
        }
      }

      // Merge the worktree branch into the base branch
      const result = await pi.exec("git", ["-C", originalCwd, "merge", worktreeName]);

      if (result.code !== 0) {
        const output = result.stderr || result.stdout || "merge failed";
        ctx.ui.notify(`Merge failed: ${output.slice(0, 200)}`, "error");
        return;
      }

      const msg = (result.stdout || "").trim();
      if (msg.toLowerCase().includes("already up to date")) {
        ctx.ui.notify(`Already up to date with ${baseRef}.`, "info");
      } else {
        ctx.ui.notify(`Merged ${worktreeName} into ${baseRef}.`, "info");
      }
    },
  });

  pi.registerCommand("worktree:close", {
    description: "Fork the current session back to the original project directory",
    handler: async (_args, ctx) => {
      const currentCwd = ctx.sessionManager.getCwd();
      const registry = readRegistry(ctx.cwd);

      // Find the worktree matching the current cwd
      let worktreeEntry: WorktreeEntry | undefined;
      for (const entry of Object.values(registry.worktrees)) {
        if (entry.path === currentCwd) {
          worktreeEntry = entry;
          break;
        }
      }

      if (!worktreeEntry) {
        ctx.ui.notify("Current session is not inside a worktree.", "error");
        return;
      }

      const originalCwd = worktreeEntry.originalCwd;
      await createNewSession(ctx, originalCwd)
    },
  });

  pi.registerCommand("worktree:host-path", {
    description: "Print the host path to the current worktree (for opening in a host IDE)",
    handler: async (_args, ctx) => {
      const currentCwd = ctx.sessionManager.getCwd();

      if (!isInsideWorktree(currentCwd)) {
        ctx.ui.notify("Not inside a worktree. Use /worktree:open first.", "error");
        return;
      }

      const hostPath = containerToHostPath(currentCwd);
      if (!hostPath) {
        ctx.ui.notify(
          "PI_HOST_HOME is not set. Are you running outside a pi container?",
          "error"
        );
        return;
      }

      ctx.ui.notify(`Host path: ${hostPath}`, "info");
    },
  });
}
