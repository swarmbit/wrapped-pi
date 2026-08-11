// ============================================================
// wpi — nono profile for docker+nono (Phase 4)
// ============================================================
// Derives a `wpi-docker` nono profile that scopes the *Docker client's*
// host-side footprint when sandbox.backend == "nono" in docker mode:
//   nono run --profile wpi-docker --allow-cwd --rollback -- docker <args>
//
// What the profile grants (least privilege for the docker CLI):
//   - the docker daemon socket            (filesystem.unix_socket; connect)
//   - ~/.pi                               (filesystem.allow — config/agent state)
//   - $TMPDIR and /tmp                    (filesystem.allow — build context lives here)
//   - each declared docker mount's host path, as read (ro) or allow (rw)
//   - extends `default` so the docker binary + system paths are readable
// What it does NOT grant: anything else. Everything not listed is denied.
//
// Honest boundary (per plan §4): nono scopes the docker CLIENT only. In-container
// network/traffic is Docker's, not nono's — nono does not filter in-container
// traffic. The Phase 4 win is socket + build-context + mount scoping, blunting the
// "Docker socket / broad mounts" risk class without giving up image reproducibility.
//
// Slice 1 (this file): filesystem grants only. Registry/network L7 filtering of
// the client's pulls is a later refinement — the profile leaves the client's
// network open (extends `default`, no network block) so image pulls work.
//
// Drift + never-overwrite follow the same pattern as the host `wpi` profile.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { debugLog, DEFAULT_NONO_DOCKER_PROFILE, type MountMapping } from "../config";
import { serializeCanonicalJson } from "./canonical-json";
import { expandFsPath } from "./profile";

/** Profile name wpi authors and passes to `nono run --profile wpi-docker`. */
export const WPI_DOCKER_PROFILE_NAME = DEFAULT_NONO_DOCKER_PROFILE;

/** The base profile wpi-docker extends (system-binary read access). */
export const WPI_DOCKER_PROFILE_EXTENDS = "default";

/** Full path where wpi writes the docker-mode profile. */
export function wpiDockerProfilePath(homeDir: string, profileName: string = WPI_DOCKER_PROFILE_NAME): string {
  return path.join(homeDir, ".config", "nono", "profiles", `${profileName}.json`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WpiDockerProfile = Record<string, any>;

/** Input to buildWpiDockerProfile. */
export interface DockerProfileInput {
  /** wpi package version (meta.version). */
  wpiVersion: string;
  /** Host home dir (for ~ / $HOME expansion). */
  homeDir: string;
  /** Docker daemon socket path (docker.socket). */
  dockerSocket: string;
  /** Declared docker.mounts (host side is granted per mount mode). */
  mounts: readonly MountMapping[];
  /** Profile file name (nono.dockerProfile). Defaults to wpi-docker. */
  profileName?: string;
}

/**
 * Build the canonical `wpi-docker` profile from resolved config.
 * Pure function — safe to call in tests.
 */
export function buildWpiDockerProfile(input: DockerProfileInput): WpiDockerProfile {
  const homeDir = input.homeDir;
  const allow: string[] = [];
  const read: string[] = [];
  const unixSocket: string[] = [];

  // Docker daemon socket — connect(2) only (the client connects, never binds).
  // Normalise a stray unix:// prefix (the config resolver strips it from
  // $DOCKER_HOST, but an explicit docker.socket value may carry it).
  if (input.dockerSocket) {
    unixSocket.push(expandFsPath(input.dockerSocket, homeDir).replace(/^unix:\/\//, ""));
  }

  // ~/.pi — config / agent state passed into the container.
  allow.push(path.join(homeDir, ".pi"));

  // Build context lives under tmpdir; grant the OS temp dir(s) read+write.
  const tmpdir = os.tmpdir();
  allow.push(tmpdir);
  // Conventional /tmp is commonly used on Linux; harmless to also grant on macOS.
  if (tmpdir !== "/tmp") allow.push("/tmp");

  // Declared mounts: grant the host side per mount mode (ro → read, rw → allow).
  for (const m of input.mounts) {
    const host = expandFsPath(m.host, homeDir);
    if (m.mode === "ro") read.push(host);
    else allow.push(host);
  }

  const filesystem: Record<string, string[]> = {};
  const dedupAllow = Array.from(new Set(allow));
  const dedupRead = Array.from(new Set(read));
  if (dedupAllow.length > 0) filesystem.allow = dedupAllow;
  if (dedupRead.length > 0) filesystem.read = dedupRead;
  if (unixSocket.length > 0) filesystem.unix_socket = Array.from(new Set(unixSocket));

  const profile: WpiDockerProfile = {
    meta: {
      name: input.profileName ?? WPI_DOCKER_PROFILE_NAME,
      version: input.wpiVersion,
      description: "wpi docker-mode nono profile (scopes the docker client)",
      author: "wpi",
    },
    extends: WPI_DOCKER_PROFILE_EXTENDS,
  };
  if (Object.keys(filesystem).length > 0) profile.filesystem = filesystem;
  return profile;
}

/** Deterministic serialisation (sorted keys + trailing newline). */
export function serializeWpiDockerProfile(profile: WpiDockerProfile): string {
  return serializeCanonicalJson(profile);
}

export interface EnsureDockerProfileResult {
  path: string;
  written: boolean;
  drifted: boolean;
  inSync: boolean;
}

/**
 * Ensure the `wpi-docker` profile exists; report drift; never overwrite.
 * Same write-if-absent / never-overwrite contract as `ensureWpiProfile`.
 */
export function ensureWpiDockerProfile(input: DockerProfileInput): EnsureDockerProfileResult {
  const profileName = input.profileName ?? WPI_DOCKER_PROFILE_NAME;
  const profilePath = wpiDockerProfilePath(input.homeDir, profileName);
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    debugLog(`Created nono profiles dir: ${dir}`);
  }

  const canonical = serializeWpiDockerProfile(buildWpiDockerProfile(input));

  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, canonical, { encoding: "utf-8" });
    debugLog(`Wrote wpi-docker profile to ${profilePath}`);
    return { path: profilePath, written: true, drifted: false, inSync: false };
  }

  const onDisk = fs.readFileSync(profilePath, "utf-8");
  if (onDisk === canonical) {
    debugLog(`wpi-docker profile in sync at ${profilePath}`);
    return { path: profilePath, written: false, drifted: false, inSync: true };
  }
  debugLog(`wpi-docker profile DRIFT at ${profilePath} (not overwriting)`);
  return { path: profilePath, written: false, drifted: true, inSync: false };
}

export interface ProfileGrantCheck {
  kind: "mount" | "socket";
  /** Expanded host path checked. */
  path: string;
  /** Whether the profile grants access to this path. */
  granted: boolean;
}

/**
 * Check that the profile grants everything the docker client needs for the
 * declared config: the daemon socket (connect) and every docker.mount host
 * path. `profile` is the profile to verify against — the canonical build for
 * config-derived checks, or the on-disk profile to detect drift-caused gaps.
 * A path not granted would fail at runtime when the docker client touches it
 * under nono; this surfaces it for the doctor report and run-time fail-fast.
 */
export function checkProfileGrants(input: DockerProfileInput, profile: WpiDockerProfile): ProfileGrantCheck[] {
  const fsSection = (profile.filesystem ?? {}) as Record<string, string[]>;
  const allow = new Set<string>(fsSection.allow ?? []);
  const read = new Set<string>(fsSection.read ?? []);
  const sock = new Set<string>(fsSection.unix_socket ?? []);

  // Normalise like the builder does so checks match grants.
  const socketPath = expandFsPath(input.dockerSocket, input.homeDir).replace(/^unix:\/\//, "");
  const checks: ProfileGrantCheck[] = [
    { kind: "socket", path: socketPath, granted: sock.has(socketPath) },
  ];
  for (const m of input.mounts) {
    const host = expandFsPath(m.host, input.homeDir);
    checks.push({
      kind: "mount",
      path: host,
      granted: allow.has(host) || read.has(host) || sock.has(host),
    });
  }
  return checks;
}