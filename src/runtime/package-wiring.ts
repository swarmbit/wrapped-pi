// ============================================================
// wpi — host-mode package wiring (Phase 5)
// ============================================================
// The bundled pi package (package/ in the wpi npm package) lives at
// ~/.pi/.wpi/package in BOTH modes:
//   - docker mode: the image bakes a bootstrap source; the entrypoint
//     syncs it into ${USER_HOME}/.pi/.wpi/package (the mounted host
//     ~/.pi) and runs `pi install` on that path.
//   - host mode: wpi copies package/ → ~/.pi/.wpi/package and wires
//     the same absolute path into ~/.pi/agent/settings.json (pi
//     resolves local paths from settings without copying).
//
// A2 model (fixed path, overwrite on upgrade):
//   - The copy is disposable, wpi-owned state — like node_modules.
//     When the bundled source changes, wpi replaces the copy wholesale
//     so upgrades actually land. Customizations belong in the user's
//     own packages, not in this copy.
//   - Settings merge is surgical: user packages (string or object
//     entries) and every other settings key are left untouched; wpi
//     only appends its own path (or no-ops when already wired).
//   - dry-run and doctor never write (doctor inspects only).
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** Hidden wpi state dir under ~/.pi. */
export function wpiStateDir(homeDir: string): string {
  return path.join(homeDir, ".pi", ".wpi");
}

/** Fixed host dir where the bundled package is copied: ~/.pi/.wpi/package. */
export function wpiPackageDir(homeDir: string): string {
  return path.join(wpiStateDir(homeDir), "package");
}

/**
 * Directory pi stores user settings in (settings.json lives there).
 * Mirrors the container entrypoint's PI_AGENT_HOME convention.
 */
export function agentSettingsPath(configDir: string): string {
  return path.join(configDir, "agent", "settings.json");
}

/**
 * The bundled package source shipped inside the wpi npm package.
 * `moduleDir` defaults to this file's runtime dir (dist/runtime) so the
 * resolved path is <package-root>/package; tests inject their own source.
 */
export function wpiPackageSourceDir(moduleDir: string = __dirname): string {
  return path.join(moduleDir, "..", "..", "package");
}

// ── Copy (fixed path, replace on change) ─────────────────────

export interface CopyResult {
  /** The fixed destination dir. */
  path: string;
  /** copied = freshly written; upgraded = replaced with the bundled source; in-sync = identical. */
  action: "copied" | "upgraded" | "in-sync";
  /** Paths (relative) that differed from the bundled source (upgraded only). */
  differing: string[];
}

function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Recursively map relative path → sha256 for a directory. Skips nothing (source is wpi-owned). */
function treeHash(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const entryRel = rel === "" ? entry.name : path.join(rel, entry.name);
      if (entry.isDirectory()) walk(entryRel);
      else out.set(entryRel, sha256(path.join(dir, entryRel)));
    }
  };
  walk("");
  return out;
}

/** Relative paths that differ between source and dest (or exist on only one side). */
function diffTrees(sourceDir: string, dest: string): string[] {
  const sourceHash = treeHash(sourceDir);
  const onDiskHash = treeHash(dest);
  const keys = new Set([...sourceHash.keys(), ...onDiskHash.keys()]);
  return [...keys].filter((k) => sourceHash.get(k) !== onDiskHash.get(k)).sort();
}

/** Read-only state of the on-disk copy vs the bundled source (doctor never writes). */
export type PackageCopyState =
  | { state: "missing" }
  | { state: "in-sync" }
  | { state: "stale"; differing: string[] };

export function compareWpiPackage(sourceDir: string, dest: string): PackageCopyState {
  if (!fs.existsSync(dest)) return { state: "missing" };
  const differing = diffTrees(sourceDir, dest);
  return differing.length === 0 ? { state: "in-sync" } : { state: "stale", differing };
}

/**
 * Ensure the fixed copy matches the bundled source. Idempotent: identical
 * on-disk copy → in-sync; missing → copied; differing → replaced wholesale
 * (the copy is disposable wpi-owned state, like node_modules).
 */
export function ensureWpiPackageCopy(sourceDir: string, homeDir: string): CopyResult {
  const dest = wpiPackageDir(homeDir);
  const compare = compareWpiPackage(sourceDir, dest);
  if (compare.state === "in-sync") return { path: dest, action: "in-sync", differing: [] };

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(sourceDir, dest, { recursive: true });
  return {
    path: dest,
    action: compare.state === "missing" ? "copied" : "upgraded",
    differing: compare.state === "stale" ? compare.differing : [],
  };
}

// ── Settings wiring (surgical merge, user state untouched) ──

export interface WireResult {
  /** Absolute path wired into settings (or would-be path when already). */
  packagePath: string;
  /** added = appended; already = present (no-op); skipped-malformed = settings unreadable, left untouched. */
  action: "added" | "already" | "skipped-malformed";
}

/**
 * Idempotently add `packagePath` to the packages array of settings.json.
 * - Other keys and every existing package entry (string or object form)
 *   are preserved verbatim — wpi never removes entries.
 * - A settings file that exists but cannot be parsed is left UNTOUCHED
 *   (skipped-malformed) — wpi never destroys user state.
 * - Writes the file (2-space JSON) only when something changed.
 */
export function wireSettings(settingsPath: string, packagePath: string): WireResult {
  if (fs.existsSync(settingsPath) && !isParsableJson(settingsPath)) {
    return { packagePath: path.resolve(packagePath), action: "skipped-malformed" };
  }
  const settings = readSettings(settingsPath);
  const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];

  const resolvedTarget = path.resolve(packagePath);
  const settingsDir = path.dirname(settingsPath);
  const already = packages.some(
    (entry) => typeof entry === "string" && path.resolve(settingsDir, entry) === resolvedTarget
  );
  if (already) return { packagePath: resolvedTarget, action: "already" };

  packages.push(resolvedTarget);
  settings.packages = packages;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return { packagePath: resolvedTarget, action: "added" };
}

function isParsableJson(p: string): boolean {
  try {
    JSON.parse(fs.readFileSync(p, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

function readSettings(settingsPath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Unreachable via wireSettings (guarded by isParsableJson first); defensive
    // for direct callers. Treat as empty rather than throwing.
    return {};
  }
}

/**
 * Read settings.json for inspection (doctor). Returns null when the file is
 * missing or malformed — callers distinguish via existsSync if they need to.
 * Never writes.
 */
export function readSettingsForDoctor(settingsPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Native binaries manifest ─────────────────────────────────

/**
 * Native binaries the bundled package's extensions shell out to, declared in
 * package/package.json under `wpi.nativeBinaries`. Doctor verifies each exists
 * on the host (docker mode bakes them into the image instead).
 */
export function readNativeBinaries(packageDir: string): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
    const bins = manifest?.wpi?.nativeBinaries;
    return Array.isArray(bins) ? bins.filter((b: unknown): b is string => typeof b === "string") : [];
  } catch {
    return [];
  }
}

// ── Combined entry point used by HostBackend ─────────────────

export interface WiringResult {
  copy: CopyResult;
  wire?: WireResult;
  /** Native binaries declared by the package (manifest). */
  nativeBinaries: string[];
}

/**
 * Copy (if needed) + wire (if needed) the bundled package for host mode.
 * The copy is disposable wpi-owned state: replaced wholesale when the
 * bundled source changed. Settings wiring only ever appends (user state
 * untouched).
 */
export function ensurePackageWiring(sourceDir: string, homeDir: string, settingsPath: string): WiringResult {
  const copy = ensureWpiPackageCopy(sourceDir, homeDir);
  const wire = wireSettings(settingsPath, copy.path);
  return { copy, wire, nativeBinaries: readNativeBinaries(sourceDir) };
}
