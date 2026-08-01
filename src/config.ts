// ============================================================
// wpi — Config discovery and loading
// ============================================================
// Configurable settings: ports, env, and mounts.
// Pi version and image are baked into this npm package.
//
// Config precedence (highest wins):
//   1. CLI flags              (-p, --port)
//   2. User config            (~/.pi/wpi.yml)
//   3. Project config           (.pi/wpi.yml)
//   4. (none — no built-in defaults for ports/env/mounts)
//
// Config file schema:
//   runtime:
//     mode: docker         # docker | host (default: docker)
//   pi:
//     version: 0.83.0      # override pi version (default: baked-in)
//   docker:
//     ports:
//       - 3000
//       - 8080:80
//     env:
//       ANTHROPIC_API_KEY: sk-xxx
//     mounts:
//       - /var/run/docker.sock:/var/run/docker.sock
//       - ~/.ssh:/home/pi-user/.ssh:ro
//     volumes:
//       - cache-vol:/home/user/.cache
//     memory: 4g
//     memorySwap: 4g
//     extension: |
//       RUN apt-get install -y python3
//   git:
//     user:
//       name: John Doe
//       email: john@example.com
// ============================================================

import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import yaml from "js-yaml";

// ── Debug logging ────────────────────────────────────────────

let DEBUG = false;

export function setDebug(enabled: boolean): void {
  DEBUG = enabled;
}

export function isDebug(): boolean {
  return DEBUG;
}

export function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    console.error("[DEBUG]", ...args);
  }
}

// ── Package constants ──────────────────────────────────────────

/** Pi version shipped by this version of wpi. */
export const PI_VERSION = "0.83.0";

/** Docker image tag derived from the pi version. */
export const PI_IMAGE = `pi-agent:${PI_VERSION}`;

// ── Types ──────────────────────────────────────────────────────

/** Runtime backend modes supported by wpi. */
export const RUNTIME_MODES = ["docker", "host"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** Default runtime mode. Docker remains the default for backwards compatibility. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "docker";

/** Validate a raw runtime.mode value from config or CLI. Throws on invalid input. */
export function parseRuntimeMode(value: string, source: string): RuntimeMode {
  if ((RUNTIME_MODES as readonly string[]).includes(value)) {
    return value as RuntimeMode;
  }
  throw new Error(
    `Invalid runtime mode "${value}" in ${source}. Expected one of: ${RUNTIME_MODES.join(", ")}.`
  );
}

export interface PortMapping {
  /** Host port */
  host: number;
  /** Container port */
  container: number;
}

export interface MountMapping {
  /** Host path */
  host: string;
  /** Container path */
  container: string;
  /** Mount mode (e.g. "ro", "rw", "cached"). Default: no mode (read-write). */
  mode?: string;
}

export interface VolumeMapping {
  /** Docker volume name */
  name: string;
  /** Container path */
  container: string;
  /** Mount mode (e.g. "ro", "rw"). Default: no mode (read-write). */
  mode?: string;
}

/** User-configurable settings (from wpi.yml). */
export interface PiContainerConfig {
  /** Runtime backend mode (runtime.mode). Defaults to "docker". */
  runtimeMode: RuntimeMode;
  /** Pi version to use (pi.version). Defaults to the version baked into this wpi release. */
  piVersion: string;
  ports: PortMapping[];
  env: Record<string, string>;
  mounts: MountMapping[];
  /** Named Docker volumes that are created and mounted into the container (docker.volumes). */
  volumes?: VolumeMapping[];
  /** Maximum memory for the container (docker.memory). Example: "4g". */
  memory?: string;
  /** Memory swap limit (docker.memorySwap). Example: "4g". */
  memorySwap?: string;
  /** Extra Dockerfile instructions appended during image build (docker.extension). */
  dockerfileExtension?: string;
  /** Git user name for commits inside the container (git.user.name). */
  gitUserName?: string;
  /** Git user email for commits inside the container (git.user.email). */
  gitUserEmail?: string;
}

/** Runtime context (derived from environment, not user-configurable). */
export interface RuntimeContext {
  configDir: string;      // absolute host path (~/.pi)
  containerDir: string;   // absolute path to .pi dir, "" if none
  projectDir: string;     // absolute path — CWD
  workspaceDir: string;   // absolute path — CWD - inside container
  debug: boolean;         // debug mode enabled
  /** Docker image tag derived from piVersion. Not user-configurable. */
  piImage: string;
}

export interface LoadConfigOptions {
  /** Override home directory (for testing). */
  homeDir?: string;
  /** Port mappings from CLI -p flags (highest precedence). */
  cliPorts?: string[];
  /** Runtime mode from CLI --mode flag (highest precedence). Overrides config files; never written back. */
  cliMode?: string;
  /** Enable debug logging. */
  debug?: boolean;
}

// ── Config file schema ────────────────────────────────────────

interface ConfigFile {
  runtime?: {
    /** Runtime backend: docker | host. Default: docker. */
    mode?: string;
  };
  pi?: {
    /** Override the pi version used to build/run the container. */
    version?: string;
  };
  docker?: {
    ports?: (number | string)[];
    env?: Record<string, string>;
    mounts?: string[];
    /** Named Docker volumes in the form "volumeName:container/path[:mode]" */
    volumes?: string[];
    memory?: string;
    memorySwap?: string;
    /** Extra Dockerfile instructions appended at the end of the image build. */
    extension?: string;
  };
  git?: {
    user?: {
      name?: string;
      email?: string;
    };
  };
}

// ── Loading ────────────────────────────────────────────────────

export function loadConfig(options?: LoadConfigOptions): PiContainerConfig & RuntimeContext {
  const projectDir = process.cwd();
  const containerDir = findContainerDir(projectDir);
  const homeDir = options?.homeDir ?? getHomeDir();

  // Load project config: .pi/wpi.yml (team-committed)
  let projectConfig: ConfigFile = {};
  if (containerDir) {
    const configPath = path.join(containerDir, "wpi.yml");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      projectConfig = (yaml.load(raw) as ConfigFile) || {};
    }
  }

  // Load user config: ~/.pi/wpi.yml (personal, not committed)
  let userConfig: ConfigFile = {};
  const userConfigPath = path.join(homeDir, ".pi", "wpi.yml");
  if (fs.existsSync(userConfigPath)) {
    const raw = fs.readFileSync(userConfigPath, "utf-8");
    userConfig = (yaml.load(raw) as ConfigFile) || {};
  }

  const configDir = path.join(homeDir, ".pi");

  // Resolve port mappings: CLI > user config > project config
  const cliPorts: PortMapping[] = (options?.cliPorts ?? []).map(parsePortMapping);
  const userPorts: PortMapping[] = parseConfigPorts(userConfig.docker?.ports);
  const projectPorts: PortMapping[] = parseConfigPorts(projectConfig.docker?.ports);
  const ports = mergePorts(cliPorts, userPorts, projectPorts);

  // Resolve env: user config overrides project config
  const env: Record<string, string> = {
    ...(projectConfig.docker?.env ?? {}),
    ...(userConfig.docker?.env ?? {}),
  };

  // Dockerfile extension: project config overrides user config
  const dockerfileExtension =
    (projectConfig.docker?.extension ?? userConfig.docker?.extension)?.trimEnd();

  // Mounts: merge project + user (user can add to project mounts, not replace)
  const projectMounts: MountMapping[] = parseConfigMounts(projectConfig.docker?.mounts);
  const userMounts: MountMapping[] = parseConfigMounts(userConfig.docker?.mounts);
  // Merge with later mounts overriding earlier ones on matching container paths
  const mounts = mergeMounts(projectMounts, userMounts);

  // Named volumes: merge project + user (user can add/override)
  const projectVolumes: VolumeMapping[] = parseConfigVolumes(projectConfig.docker?.volumes);
  const userVolumes: VolumeMapping[] = parseConfigVolumes(userConfig.docker?.volumes);
  const volumes = mergeVolumes(projectVolumes, userVolumes);

  // Memory settings: project config overrides user config
  const memory = projectConfig.docker?.memory ?? userConfig.docker?.memory;
  const memorySwap = projectConfig.docker?.memorySwap ?? userConfig.docker?.memorySwap;

  // Pi version: project config > user config > baked-in constant
  const piVersion: string =
    projectConfig.pi?.version ??
    userConfig.pi?.version ??
    PI_VERSION;

  // Runtime mode: CLI flag > user config > project config > default ("docker").
  // Invalid values fail fast with a source-labeled error.
  const runtimeMode: RuntimeMode = options?.cliMode
    ? parseRuntimeMode(options.cliMode, "--mode flag")
    : userConfig.runtime?.mode
      ? parseRuntimeMode(userConfig.runtime.mode, getUserConfigPath(homeDir))
      : projectConfig.runtime?.mode
        ? parseRuntimeMode(
            projectConfig.runtime.mode,
            path.join(containerDir, "wpi.yml")
          )
        : DEFAULT_RUNTIME_MODE;

  // Docker image tag derived from the resolved pi version (not user-configurable)
  const piImage = `pi-agent:${piVersion}`;

  // Git user name: project config > user config > host git config
  const gitUserName: string | undefined =
    projectConfig.git?.user?.name ??
    userConfig.git?.user?.name ??
    inferGitConfig(homeDir, "user.name");

  // Git user email: project config > user config > host git config
  const gitUserEmail: string | undefined =
    projectConfig.git?.user?.email ??
    userConfig.git?.user?.email ??
    inferGitConfig(homeDir, "user.email");

  return {
    runtimeMode,
    piVersion,
    ports,
    env,
    mounts,
    volumes,
    memory,
    memorySwap,
    dockerfileExtension,
    gitUserName,
    gitUserEmail,
    configDir,
    containerDir,
    projectDir,
    workspaceDir: projectDir,
    debug: options?.debug ?? false,
    piImage,
  };
}

// ── Discovery helpers ─────────────────────────────────────────

function findContainerDir(projectDir: string): string {
  const candidate = path.join(projectDir, ".pi");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return "";
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/root";
}

/**
 * Infer a git config value from the host machine.
 * Runs `git config <key>` to read the user's git configuration.
 * Returns undefined if the command fails or produces no output.
 */
function inferGitConfig(homeDir: string, key: string): string | undefined {
  try {
    // If loadConfig was given an explicit homeDir (used in tests), prefer to read
    // only that directory's git config file so tests are deterministic and do not
    // pick up the machine-global git config.
    const defaultHome = getHomeDir();
    let args: string[];
    if (homeDir && homeDir !== defaultHome) {
      // Read from specific file under the provided homeDir
      const cfgPath = path.join(homeDir, '.gitconfig');
      args = ["config", "--file", cfgPath, "--get", key];
    } else {
      // No explicit override — read from host git config (global/system)
      args = ["config", "--get", key];
    }

    const result = spawnSync("git", args, {
      cwd: homeDir,
      stdio: "pipe",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const value = result.stdout.toString().trim();
      if (value) {
        debugLog(`Inferred git ${key} from host: ${value}`);
        return value;
      }
    }
    debugLog(`Could not infer git ${key} from host (status: ${result.status})`);
    return undefined;
  } catch (e) {
    debugLog(`Error inferring git ${key}: ${e}`);
    return undefined;
  }
}

// ── Port parsing ────────────────────────────────────────────────

/** Parse a single port string like "3000" or "8080:3000". */
export function parsePortMapping(input: string): PortMapping {
  const trimmed = input.trim();

  // Host:Container — "8080:3000"
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid port mapping: "${input}". Expected HOST:CONTAINER format.`);
    }
    const host = parseInt(parts[0], 10);
    const container = parseInt(parts[1], 10);
    if (
      isNaN(host) || isNaN(container) ||
      String(host) !== parts[0] || String(container) !== parts[1] ||
      host <= 0 || container <= 0 || host > 65535 || container > 65535
    ) {
      throw new Error(`Invalid port mapping: "${input}". Ports must be 1-65535.`);
    }
    return { host, container };
  }

  // Range — "9000-9010"
  if (trimmed.includes("-")) {
    throw new Error(
      `Port ranges ("${input}") are only supported in config files, not as individual mappings. Use separate entries instead.`
    );
  }

  // Simple port — "3000"
  const port = parseInt(trimmed, 10);
  if (isNaN(port) || String(port) !== trimmed || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${input}". Must be 1-65535.`);
  }
  return { host: port, container: port };
}

/** Parse a comma-separated port string (from config file). Supports ranges. */
export function parsePortsString(input: string): PortMapping[] {
  const mappings: PortMapping[] = [];
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    mappings.push(...expandPortPart(part));
  }
  return mappings;
}

/** Parse a single part from config/ports — can be a number, "host:container", or "start-end". */
function expandPortPart(part: string): PortMapping[] {
  // Range: "9000-9010"
  if (part.includes("-") && !part.includes(":")) {
    const [startStr, endStr] = part.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (
      isNaN(start) || isNaN(end) ||
      String(start) !== startStr || String(end) !== endStr ||
      start > end || start <= 0 || end > 65535
    ) {
      throw new Error(`Invalid port range: "${part}"`);
    }
    const mappings: PortMapping[] = [];
    for (let i = start; i <= end; i++) {
      mappings.push({ host: i, container: i });
    }
    return mappings;
  }

  // Host:Container: "8080:3000"
  if (part.includes(":")) {
    const parts = part.split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid port mapping: "${part}". Expected HOST:CONTAINER format.`);
    }
    const host = parseInt(parts[0], 10);
    const container = parseInt(parts[1], 10);
    if (
      isNaN(host) || isNaN(container) ||
      String(host) !== parts[0] || String(container) !== parts[1] ||
      host <= 0 || container <= 0 || host > 65535 || container > 65535
    ) {
      throw new Error(`Invalid port mapping: "${part}"`);
    }
    return [{ host, container }];
  }

  // Simple port: "3000"
  const port = parseInt(part, 10);
  if (isNaN(port) || String(port) !== part || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: "${part}"`);
  }
  return [{ host: port, container: port }];
}

/** Parse port entries from config file (can be numbers or strings). */
function parseConfigPorts(ports: (number | string)[] | undefined): PortMapping[] {
  if (!ports) return [];
  const mappings: PortMapping[] = [];
  for (const entry of ports) {
    mappings.push(...expandPortPart(String(entry)));
  }
  return mappings;
}

/** Merge port lists with later entries overriding earlier ones on conflict.
 *  Highest precedence first: CLI > user > project. */
function mergePorts(...lists: PortMapping[][]): PortMapping[] {
  const seen = new Map<number, PortMapping>();
  // Process in reverse so higher precedence wins
  for (let i = lists.length - 1; i >= 0; i--) {
    for (const mapping of lists[i]) {
      seen.set(mapping.host, mapping);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.host - b.host);
}

/** Parse mount entries from config file (each is a string like /host:/container or /host:/container:ro). */
function parseConfigMounts(mounts: string[] | undefined): MountMapping[] {
  if (!mounts) return [];
  const mappings: MountMapping[] = [];
  for (const entry of mounts) {
    mappings.push(parseMountMapping(entry));
  }
  return mappings;
}

/** Parse a single mount string like "/host:/container" or "/host:/container:ro". */
export function parseMountMapping(input: string): MountMapping {
  const trimmed = input.trim();
  const parts = trimmed.split(":");

  if (parts.length === 2) {
    // /host:/container
    const [host, container] = parts;
    if (!host || !container) {
      throw new Error(`Invalid mount mapping: "${input}". Expected HOST:CONTAINER format.`);
    }
    return { host, container };
  }

  if (parts.length === 3) {
    // /host:/container:mode
    const [host, container, mode] = parts;
    if (!host || !container || !mode) {
      throw new Error(`Invalid mount mapping: "${input}". Expected HOST:CONTAINER:MODE format.`);
    }
    return { host, container, mode };
  }

  throw new Error(`Invalid mount mapping: "${input}". Expected HOST:CONTAINER or HOST:CONTAINER:MODE format.`);
}

/** Merge mount lists. Later entries override earlier ones on matching container paths. */
function mergeMounts(project: MountMapping[], user: MountMapping[]): MountMapping[] {
  // Use Map keyed by container path for dedup; user mounts win over project
  const seen = new Map<string, MountMapping>();
  for (const m of project) {
    seen.set(m.container, m);
  }
  for (const m of user) {
    seen.set(m.container, m);
  }
  return Array.from(seen.values());
}

/** Parse volume entries from config file (each is a string like "volname:/container/path" or "volname:/container/path:ro"). */
function parseConfigVolumes(volumes: string[] | undefined): VolumeMapping[] {
  if (!volumes) return [];
  const mappings: VolumeMapping[] = [];
  for (const entry of volumes) {
    mappings.push(parseVolumeMapping(entry));
  }
  return mappings;
}

/** Parse a single volume string like "volname:/container" or "volname:/container:mode". */
export function parseVolumeMapping(input: string): VolumeMapping {
  const trimmed = input.trim();
  const parts = trimmed.split(":");

  if (parts.length >= 2) {
    const name = parts[0];
    const container = parts[1];
    if (!name || !container) {
      throw new Error(`Invalid volume mapping: "${input}". Expected VOLUME_NAME:CONTAINER format.`);
    }
    if (parts.length === 2) {
      return { name, container };
    }
    // mode may contain additional colons, join the rest
    const mode = parts.slice(2).join(":");
    if (!mode) {
      throw new Error(`Invalid volume mapping: "${input}". Expected VOLUME_NAME:CONTAINER:MODE format.`);
    }
    return { name, container, mode };
  }

  throw new Error(`Invalid volume mapping: "${input}". Expected VOLUME_NAME:CONTAINER or VOLUME_NAME:CONTAINER:MODE format.`);
}

/** Merge volume lists. Later entries override earlier ones on matching container paths. */
function mergeVolumes(project: VolumeMapping[], user: VolumeMapping[]): VolumeMapping[] {
  const seen = new Map<string, VolumeMapping>();
  for (const v of project) {
    seen.set(v.container, v);
  }
  for (const v of user) {
    seen.set(v.container, v);
  }
  return Array.from(seen.values());
}

/** Check if a port is available on localhost. Returns true if available. */
export async function checkPortAvailable(port: number): Promise<boolean> {
  const net = await import("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

/** Get the user config path for a given home directory. */
export function getUserConfigPath(homeDir?: string): string {
  return path.join(homeDir ?? getHomeDir(), ".pi", "wpi.yml");
}
