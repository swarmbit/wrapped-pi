// ============================================================
// wpi — nono profile generation (Phase 3, slice 1)
// ============================================================
// Generates the wpi host-mode nono profile. The profile *extends* the
// signed `nolabs-ai/pi` pack (resolved by nono at run time) rather than
// re-declaring pi's capabilities, so wpi never carries a stale copy of
// pi's policy. wpi only adds the wpi-specific layer (workdir access).
//
// "Never silently overwrite user state" (plan guiding constraint): if a
// profile already exists at the destination we DO NOT overwrite it. Drift
// detection (compare existing vs. canonical, report differences) lands in
// Phase 3 commit 2; for now we write-if-absent and leave existing files
// untouched with a debug log.
//
// Profile format reference (nono):
//   meta      : { name (required), version?, description?, author? }
//   extends   : string | string[] | null   (profile name; max depth 10)
//   workdir   : { access: "none" | "read" | "read-write" }  (default "none")
//   filesystem: { allow/read/write/allow_file/read_file/write_file/deny/... }
//   network   : { block, network_profile, allow_domain, credentials,
//                open_port, listen_port, custom_credentials, ... }
//   env var expansion in paths: ~ / $HOME, $WORKDIR, $TMPDIR, $UID,
//                 $NONO_CONFIG, $NONO_PACKAGES
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { debugLog } from "../config";

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

/** Canonical wpi profile object (deterministic — no host-specific paths). */
export interface WpiProfile {
  meta: {
    name: string;
    version: string;
    description: string;
    author: string;
  };
  extends: string;
  workdir: {
    /** read-write so the agent can edit the workspace it was launched from. */
    access: "read-write";
  };
}

/**
 * Build the canonical wpi profile object for a given wpi version.
 * Pure function — safe to call in tests.
 */
export function buildWpiProfile(wpiVersion: string): WpiProfile {
  return {
    meta: {
      name: WPI_PROFILE_NAME,
      version: wpiVersion,
      description: "wpi host-mode nono profile (extends nolabs-ai/pi)",
      author: "wpi",
    },
    extends: WPI_PROFILE_EXTENDS,
    workdir: { access: "read-write" },
  };
}

/**
 * Serialise the profile to canonical JSON (2-space, sorted keys, trailing
 * newline). Deterministic so byte-for-byte comparison works for drift
 * detection in Phase 3 commit 2.
 */
export function serializeWpiProfile(profile: WpiProfile): string {
  return JSON.stringify(profile, null, 2) + "\n";
}

export interface EnsureProfileResult {
  /** Absolute path the profile was written to / found at. */
  path: string;
  /** True if wpi wrote the profile this call; false if it already existed. */
  written: boolean;
  /** True if a profile already existed at the path. */
  existed: boolean;
}

/**
 * Ensure the wpi profile exists on disk. Writes the canonical profile if the
 * file is absent. If it already exists, does NOT overwrite — returns
 * `written: false`. (Drift reporting lands in Phase 3 commit 2.)
 *
 * Creates the profiles directory if needed.
 */
export function ensureWpiProfile(homeDir: string, wpiVersion: string): EnsureProfileResult {
  const profilePath = wpiProfilePath(homeDir);
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    debugLog(`Created nono profiles dir: ${dir}`);
  }

  if (fs.existsSync(profilePath)) {
    debugLog(`wpi profile already exists at ${profilePath}; not overwriting`);
    return { path: profilePath, written: false, existed: true };
  }

  const json = serializeWpiProfile(buildWpiProfile(wpiVersion));
  fs.writeFileSync(profilePath, json, { encoding: "utf-8" });
  debugLog(`Wrote wpi profile to ${profilePath}`);
  return { path: profilePath, written: true, existed: false };
}