// ============================================================
// wpi — host-mode package wiring (Phase 5)
// ============================================================
// In docker mode the bundled pi package (package/ in the wpi npm
// package) is baked into the image and installed by the entrypoint.
// Host mode runs pi natively, so wpi wires the same package locally:
//
//   1. Copy package/ → ~/.pi/wpi-package/<wpi-version>/  (versioned:
//      an upgrade lands in a NEW directory, never clobbering).
//   2. Add that absolute path to the `packages` array in
//      ~/.pi/agent/settings.json (pi resolves local paths from
//      settings without copying; identity = resolved absolute path).
//
// Contracts (mirror the nono-profile philosophy):
//   - write-if-absent, never silently overwrite. A versioned copy that
//     already exists and differs from source is a COLLISION: wpi keeps
//     the on-disk copy and reports it (delete to regenerate).
//   - settings merge is surgical: user packages (string or object
//     entries) and every other settings key are left untouched. wpi
//     only replaces entries it owns: a different wpi-package version,
//     or the stale docker-mode default (/opt/pi-package) when that path
//     does not exist on the host.
//   - dry-run and doctor never write (doctor inspects only).
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** Versioned host dir where the bundled package is copied: ~/.pi/wpi-package/<version>. */
export function wpiPackageDir(homeDir: string, wpiVersion: string): string {
  return path.join(homeDir, ".pi", "wpi-package", wpiVersion);
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

// ── Copy (versioned, idempotent, collision-safe) ─────────────

export interface CopyResult {
  /** The versioned destination dir. */
  path: string;
  /** copied = freshly written; in-sync = identical to source; collision = differs (kept on-disk). */
  action: "copied" | "in-sync" | "collision";
  /** Paths (relative) that differ between source and on-disk copy (collision only). */
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

/**
 * Ensure the versioned copy exists. Idempotent: identical on-disk copy → in-sync;
 * differing on-disk copy → collision (wpi never overwrites user state, even its own
 * copy — delete to regenerate). Upgrades get a new <version> dir, so this only
 * collides when the SAME wpi version's source changed or the user edited the copy.
 */
export function ensureWpiPackageCopy(sourceDir: string, homeDir: string, wpiVersion: string): CopyResult {
  const dest = wpiPackageDir(homeDir, wpiVersion);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(sourceDir, dest, { recursive: true });
    return { path: dest, action: "copied", differing: [] };
  }

  const sourceHash = treeHash(sourceDir);
  const onDiskHash = treeHash(dest);
  if (onDiskHash.size !== sourceHash.size) {
    return { path: dest, action: "collision", differing: diffKeys(sourceHash, onDiskHash) };
  }
  const differing = [...sourceHash.keys()].filter((k) => onDiskHash.get(k) !== sourceHash.get(k));
  if (differing.length === 0) return { path: dest, action: "in-sync", differing: [] };
  return { path: dest, action: "collision", differing };
}

function diffKeys(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

// ── Settings wiring (surgical merge, user state untouched) ──

export interface WireResult {
  /** Absolute path wired into settings (or would-be path when already). */
  packagePath: string;
  /** added = appended; already = present (no-op); replaced = swapped an owned entry; skipped-malformed = settings unreadable, left untouched. */
  action: "added" | "already" | "replaced" | "skipped-malformed";
  /** The entry replaced (owned entry or stale docker-mode default), when applicable. */
  replacedFrom?: string;
}

/** The docker-mode default package entry (image path). Wired by the container entrypoint. */
export const DOCKER_DEFAULT_PACKAGE = "/opt/pi-package";

/**
 * The docker-mode default is stale when it resolves to /opt/pi-package and that
 * path does not exist on the host (it only exists inside the container image).
 * `exists` is injectable for tests.
 */
export function isStaleDockerDefault(resolved: string, exists: (p: string) => boolean = fs.existsSync): boolean {
  return resolved === DOCKER_DEFAULT_PACKAGE && !exists(DOCKER_DEFAULT_PACKAGE);
}

/** True when a string entry is a wpi-owned host package entry (~/.pi/wpi-package/<version>). */
export function isWpiPackageEntry(resolved: string, homeDir: string): boolean {
  const ownedPrefix = path.join(homeDir, ".pi", "wpi-package") + path.sep;
  return resolved.startsWith(ownedPrefix);
}

/**
 * Idempotently add `packagePath` to the packages array of settings.json.
 * - Other keys, object-form entries and non-wpi strings are preserved verbatim.
 * - A wpi-owned entry of a DIFFERENT version is replaced (upgrade path).
 * - The stale docker-mode default (/opt/pi-package) is dropped only when that
 *   path does not exist on the host (it resolves inside the container image).
 * - A settings file that exists but cannot be parsed is left UNTOUCHED
 *   (skipped-malformed) — wpi never destroys user state.
 * - Writes the file (2-space JSON) only when something changed.
 */
export function wireSettings(settingsPath: string, packagePath: string, homeDir: string): WireResult {
  if (fs.existsSync(settingsPath) && !isParsableJson(settingsPath)) {
    return { packagePath: path.resolve(packagePath), action: "skipped-malformed" };
  }
  const settings = readSettings(settingsPath);
  const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];

  const resolvedTarget = path.resolve(packagePath);
  const settingsDir = path.dirname(settingsPath);
  let replacedFrom: string | undefined;
  let already = false;

  const kept: unknown[] = [];
  for (const entry of packages) {
    if (typeof entry !== "string") {
      kept.push(entry); // object-form filter entries: user state, keep
      continue;
    }
    const resolved = path.resolve(settingsDir, entry);
    if (resolved === resolvedTarget) {
      already = true; // our exact entry already present
      kept.push(entry);
      continue;
    }
    if (isWpiPackageEntry(resolved, homeDir) || isStaleDockerDefault(resolved)) {
      // wpi-owned entry (another version) or the stale docker-mode default. Drop
      // it — replaced below with the current host path. A docker-default entry
      // whose path EXISTS on the host is kept (user relies on it).
      replacedFrom = replacedFrom ?? resolved;
      continue;
    }
    kept.push(entry); // user package
  }

  if (already && replacedFrom === undefined) {
    return { packagePath: resolvedTarget, action: "already" };
  }

  if (!already) kept.push(resolvedTarget);

  settings.packages = kept;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return { packagePath: resolvedTarget, action: replacedFrom ? "replaced" : "added", replacedFrom };
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
 * Never overwrites: collisions are reported via the returned result; the
 * caller decides how loudly to surface them.
 */
export function ensurePackageWiring(sourceDir: string, homeDir: string, wpiVersion: string, settingsPath: string): WiringResult {
  const copy = ensureWpiPackageCopy(sourceDir, homeDir, wpiVersion);
  const wire = wireSettings(settingsPath, copy.path, homeDir);
  return { copy, wire, nativeBinaries: readNativeBinaries(sourceDir) };
}
