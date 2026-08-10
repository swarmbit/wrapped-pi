// ============================================================
// wpi — nono profile generation (Phase 3)
// ============================================================
// Generates the wpi host-mode nono profile. The profile *extends* the
// signed `nolabs-ai/pi` pack (resolved by nono at run time) rather than
// re-declaring pi's capabilities, so wpi never carries a stale copy of
// pi's policy. wpi only adds the wpi-specific layer:
//   - workdir.access  = readwrite (the launched workspace; nono uses `readwrite`, not `read-write`)
//   - filesystem.allow/read  from workspace/nono fs grants
//   - network.{network_profile?, allow_domain, credentials, custom_credentials}
//       from the `network:` config section (mode "filtered" enables the proxy)
//   - environment.deny_vars = env var names covered by credential routes
//       (route wins: the REAL key never enters the child; nono injects a phantom)
//
// Drift detection (Phase 3 commit 2): the canonical profile is recomputed from
// resolved config on each run. If the on-disk profile differs, NEVER overwrite
// it — report drift in `doctor` and warn at run time. To regenerate, the user
// deletes the file (documented). This preserves "never silently overwrite user
// state".
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { debugLog } from "../config";
import type {
  NetworkConfig,
  NonoConfig,
  WorkspaceConfig,
  PresetCredentialService,
  CustomCredentialDef,
} from "../config";
import { PRESET_CREDENTIAL_ENV_VAR } from "../config";

/** Profile name wpi authors and passes to `nono run --profile wpi`. */
export const WPI_PROFILE_NAME = "wpi";

/** The signed pack the wpi profile extends. Resolved by nono at run time. */
export const WPI_PROFILE_EXTENDS = "nolabs-ai/pi";

/** Directory nono resolves user profiles from (~/.config/nono/profiles). */
export function nonoProfilesDir(homeDir: string): string {
  return path.join(homeDir, ".config", "nono", "profiles");
}

/** Full path where wpi writes its authored profile. */
export function wpiProfilePath(homeDir: string): string {
  return path.join(nonoProfilesDir(homeDir), `${WPI_PROFILE_NAME}.json`);
}

/** Input to buildWpiProfile: the resolved config fields the profile depends on. */
export interface ProfileInput {
  /** wpi package version (meta.version). */
  wpiVersion: string;
  /** Host home dir (for ~ / $HOME expansion in fs grants). */
  homeDir: string;
  /** Workspace project dir ($WORKDIR expansion). */
  workspaceDir: string;
  network: NetworkConfig;
  workspace: WorkspaceConfig | NonoConfig;
  nono: NonoConfig;
  /** Env var names covered by credential routes (route wins: deny the real key). */
  deniedEnvVars: string[];
}

/** Canonical wpi profile object (deterministic — host paths are *expanded*,
 * not embedded, so the file is portable across machines only if config matches). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WpiProfile = Record<string, any>;

/** Expand ~ / $HOME / $WORKDIR in a path. Keeps non-expanding paths verbatim. */
export function expandFsPath(p: string, homeDir: string, workspaceDir: string): string {
  return p
    .replace(/^~(?=$|\/|\\)/, homeDir)
    .replace(/\$\{?HOME\}?/g, homeDir)
    .replace(/\$\{?WORKDIR\}?/g, workspaceDir);
}

/** Compute the env var names a credential route covers (for deny_vars). */
export function credentialEnvVarNames(
  presets: readonly PresetCredentialService[],
  custom: Record<string, CustomCredentialDef> = {},
): string[] {
  const names = new Set<string>();
  for (const svc of presets) names.add(PRESET_CREDENTIAL_ENV_VAR[svc]);
  for (const def of Object.values(custom)) if (def.envVar) names.add(def.envVar);
  return Array.from(names).sort();
}

/**
 * Build the canonical wpi profile object from resolved config.
 * Pure function — safe to call in tests.
 */
export function buildWpiProfile(input: ProfileInput): WpiProfile {
  const allowPaths = [...input.workspace.allowPaths, ...input.nono.allowPaths]
    .map((p) => expandFsPath(p, input.homeDir, input.workspaceDir));
  const readPaths = [...input.workspace.readPaths, ...input.nono.readPaths]
    .map((p) => expandFsPath(p, input.homeDir, input.workspaceDir));

  const filesystem: Record<string, string[]> = {};
  const dedupedAllow = Array.from(new Set(allowPaths));
  const dedupedRead = Array.from(new Set(readPaths));
  if (dedupedAllow.length > 0) filesystem.allow = dedupedAllow;
  if (dedupedRead.length > 0) filesystem.read = dedupedRead;

  // Network section: only emitted when there's anything to say (proxy mode,
  // allow domains, credentials, or custom credential routes).
  const network: Record<string, unknown> = {};
  // "filtered" (default) → use the proxy via the wpi profile's own allowlist.
  // nono's built-in `network_profile` presets (minimal, developer, ...) are
  // NOT used; wpi composes allow_domain + credentials directly. We deliberately
  // omit network_profile so wpi's allow_domain is authoritative.
  if (input.network.mode === "blocked") {
    network.block = true;
  }
  if (input.network.allowDomains.length > 0) {
    network.allow_domain = input.network.allowDomains.slice();
  }
  if (input.network.credentials.length > 0) {
    network.credentials = input.network.credentials.slice();
  }
  if (Object.keys(input.network.customCredentials).length > 0) {
    network.custom_credentials = profileCustomCredentials(input.network.customCredentials);
  }

  // environment.deny_vars: route wins — the real key is never in the child env.
  const environment: Record<string, unknown> = {};
  if (input.deniedEnvVars.length > 0) {
    environment.deny_vars = input.deniedEnvVars.slice();
  }

  const profile: WpiProfile = {
    meta: {
      name: WPI_PROFILE_NAME,
      version: input.wpiVersion,
      description: "wpi host-mode nono profile (extends nolabs-ai/pi)",
      author: "wpi",
    },
    extends: WPI_PROFILE_EXTENDS,
    workdir: { access: "readwrite" },
  };
  if (Object.keys(filesystem).length > 0) profile.filesystem = filesystem;
  if (Object.keys(network).length > 0) profile.network = network;
  if (Object.keys(environment).length > 0) profile.environment = environment;
  return profile;
}

/** Map wpi custom credential defs to nono's `custom_credentials` shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profileCustomCredentials(custom: Record<string, CustomCredentialDef>): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(custom)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry: Record<string, any> = { upstream: def.upstream, env_var: def.envVar };
    if (def.credentialKey) entry.credential_key = def.credentialKey;
    if (def.injectHeader) entry.inject_header = def.injectHeader;
    if (def.credentialFormat) entry.credential_format = def.credentialFormat;
    if (def.injectMode) entry.inject_mode = def.injectMode;
    out[name] = entry;
  }
  return out;
}

/**
 * Serialise the profile to canonical JSON (2-space, sorted keys, trailing
 * newline). Deterministic so byte-for-byte comparison works for drift detection.
 */
export function serializeWpiProfile(profile: WpiProfile): string {
  // Stable key ordering via sorted-object stringify.
  return JSON.stringify(sortKeys(profile), null, 2) + "\n";
}

// Deep-sort object keys deterministically. Arrays preserve order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return obj;
}

// ── Write & drift detection ─────────────────────────────────

export interface EnsureProfileResult {
  path: string;
  /** True if wpi wrote the profile this call; false if it already existed. */
  written: boolean;
  /** True if a profile existed and differs from canonical (drift). */
  drifted: boolean;
  /** True if a profile existed and matched canonical. */
  inSync: boolean;
}

const _voidHomeDeprecated = os; // keep import referenced for older callers
void _voidHomeDeprecated;

/**
 * Ensure the wpi profile exists on disk AND report drift if it's stale.
 *
 * - Absent: write the canonical profile. (written=true, drifted=false)
 * - Present & equal:    no-op.          (written=false, drifted=false, inSync=true)
 * - Present & differs:  NEVER overwrite; return drifted=true so callers can warn.
 *   The on-disk profile is used as-is (respects user customization).
 *
 * Creates the profiles directory if needed.
 */
export function ensureWpiProfile(input: ProfileInput): EnsureProfileResult {
  const profilePath = wpiProfilePath(input.homeDir);
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    debugLog(`Created nono profiles dir: ${dir}`);
  }

  const canonical = serializeWpiProfile(buildWpiProfile(input));

  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, canonical, { encoding: "utf-8" });
    debugLog(`Wrote wpi profile to ${profilePath}`);
    return { path: profilePath, written: true, drifted: false, inSync: false };
  }

  const onDisk = fs.readFileSync(profilePath, "utf-8");
  if (onDisk === canonical) {
    debugLog(`wpi profile in sync at ${profilePath}`);
    return { path: profilePath, written: false, drifted: false, inSync: true };
  }

  debugLog(`wpi profile DRIFT detected at ${profilePath} (not overwriting)`);
  return { path: profilePath, written: false, drifted: true, inSync: false };
}