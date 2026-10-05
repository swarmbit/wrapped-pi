// ============================================================
// wpi — Docker operations
// ============================================================
// Builds images, runs containers, opens shells. All Docker
// interaction goes through here.
//
// Key design decisions:
//   - Uses `docker run` directly (not docker compose) so paths
//     resolve relative to CWD — fixes the mounting bug
//   - Fresh container per invocation — no state to manage
//   - Build context is a temp directory created per build,
//     incorporating only what's needed from .pi/
//   - Built-in package/ and settings/ are always copied from
//     the installed module — pi install at runtime handles
//     any additional packages
//   - The image tag is a fingerprint of the build context
//     (see image.ts), so a missing tag means "needs a build"
//   - docker.env values reach the container through a private
//     env file, not the docker command line, so they do not
//     show up in process listings
// ============================================================

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync, spawn, SpawnSyncReturns } from "child_process";
import { PiContainerConfig, RuntimeContext, debugLog, isDebug } from "./config";
import { collectBuildContext, IMAGE_REPOSITORY } from "./image";

// ── Image management ────────────────────────────────────────

export function imageExists(tag: string): boolean {
  debugLog(`Checking if image exists: ${tag}`);
  const result = spawnSync("docker", ["image", "inspect", tag], { stdio: "pipe" });
  const exists = result.status === 0;
  debugLog(`Image ${tag} exists: ${exists}${exists ? "" : " (stderr: " + result.stderr.toString().trim() + ")"}`);
  return exists;
}

/**
 * Tags of the images wpi built for other build inputs: earlier wpi versions,
 * earlier docker.extension contents, or other projects. Each distinct set of
 * inputs gets its own tag (see image.ts), and nothing replaces an old one.
 */
export function listOtherImages(keep: string): string[] {
  const result = spawnSync("docker", ["image", "ls", IMAGE_REPOSITORY, "--format", "{{.Repository}}:{{.Tag}}"], { stdio: "pipe" });
  if (result.status !== 0) return [];
  return result.stdout.toString().split("\n").map((line) => line.trim())
    .filter((tag) => tag && tag !== keep && !tag.endsWith(":<none>"));
}

/** Remove every wpi image except the one the current config uses. */
export function cleanImages(config: { piImage: string }): void {
  const others = listOtherImages(config.piImage);
  if (others.length === 0) {
    console.log("✅ No other pi-agent images to remove.");
    return;
  }
  let removed = 0;
  for (const tag of others) {
    // No --force: an image a running container still uses is left alone.
    const result = spawnSync("docker", ["image", "rm", tag], { stdio: "pipe" });
    if (result.status === 0) {
      removed++;
      console.log(`🗑️  Removed ${tag}`);
    } else {
      console.log(`⏭️  Kept ${tag}: ${result.stderr.toString().trim() || "docker image rm failed"}`);
    }
  }
  console.log(`✅ Removed ${removed} of ${others.length} image(s); kept ${config.piImage}.`);
}

// ── Build ───────────────────────────────────────────────────

export function buildImage(config: { piVersion: string; piImage: string; dockerfileExtension?: string }): void {
  console.log(`🔨 Building ${config.piImage} (pi v${config.piVersion})...`);

  const buildCtx = createBuildContext(config.piVersion, config.dockerfileExtension);
  debugLog(`Build context created at: ${buildCtx}`);

  try {
    const args = [
      "build",
      "--build-arg",
      `PI_VERSION=${config.piVersion}`,
      "-t",
      config.piImage,
      ".",
    ];

    debugLog(`Running: docker ${args.join(" ")} (cwd: ${buildCtx})`);
    const result = spawnSync("docker", args, {
      cwd: buildCtx,
      stdio: isDebug() ? "pipe" : "inherit",
    });

    if (isDebug()) {
      const out = result.stdout?.toString() || "";
      const err = result.stderr?.toString() || "";
      if (out) { process.stdout.write(out); debugLog("Build stdout:", out); }
      if (err) { process.stderr.write(err); debugLog("Build stderr:", err); }
    }

    debugLog(`Docker build exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
    if (result.status !== 0 && result.status !== null) {
      console.error(`Build failed with status ${result.status}`);
      process.exit(result.status);
    }

    console.log(`✅ Built ${config.piImage}`);
    const others = listOtherImages(config.piImage).length;
    if (others > 0) {
      console.log(`ℹ️  ${others} other pi-agent image(s) are still stored. Run 'wpi clean' to remove them.`);
    }
  } finally {
    // Clean up temp directory
    debugLog(`Cleaning up build context: ${buildCtx}`);
    fs.rmSync(buildCtx, { recursive: true, force: true });
  }
}

export function buildIfNeeded(config: { piVersion: string; piImage: string; dockerfileExtension?: string }): void {
  debugLog(`buildIfNeeded: checking for ${config.piImage}`);
  if (!imageExists(config.piImage)) {
    console.log("📦 Image not found. Building...");
    buildImage(config);
  } else {
    debugLog(`Image ${config.piImage} already exists, skipping build`);
  }
}

// ── Run ─────────────────────────────────────────────────────

/**
 * When debug mode is on, use async spawn so we can inherit stdin
 * (preserving TTY interactivity) while piping stdout/stderr for capture.
 * Without debug, use spawnSync with stdio "inherit" for direct passthrough.
 */
function spawnDocker(args: string[], debug: boolean): Promise<SpawnSyncReturns<Buffer>> {
  if (!debug) {
    // Fast path: inherit all stdio, synchronous
    const result = spawnSync("docker", args, { stdio: "inherit" });
    return Promise.resolve(result);
  }

  // Debug path: inherit stdin (keep TTY working), pipe stdout/stderr for capture
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout?.on("data", (data: Buffer) => {
      chunks.push(data);
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      errChunks.push(data);
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks);
      const stderr = Buffer.concat(errChunks);
      debugLog("Container stdout:", stdout.toString());
      debugLog("Container stderr:", stderr.toString());
      // Build a SpawnSyncReturns-shaped object so callers can use the same shape
      resolve({
        status: code,
        stdout,
        stderr,
        pid: child.pid ?? 0,
        output: [stdout, stderr],
        signal: null,
        error: undefined,
      } as unknown as SpawnSyncReturns<Buffer>);
    });

    child.on("error", (err) => {
      resolve({
        status: null,
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(errChunks),
        pid: child.pid ?? 0,
        output: [Buffer.concat(chunks), Buffer.concat(errChunks)],
        signal: null,
        error: err,
      } as unknown as SpawnSyncReturns<Buffer>);
    });
  });
}

/** `docker volume create` is idempotent — it succeeds if the volume already exists. */
function ensureVolumes(config: PiContainerConfig): void {
  for (const v of config.volumes ?? []) {
    debugLog(`Ensuring docker volume exists: ${v.name}`);
    try {
      const res = spawnSync("docker", ["volume", "create", v.name], { stdio: isDebug() ? "pipe" : "ignore" });
      if (isDebug() && res.stdout) {
        debugLog(`docker volume create stdout: ${res.stdout.toString().trim()}`);
      }
      if (isDebug() && res.stderr) {
        debugLog(`docker volume create stderr: ${res.stderr.toString().trim()}`);
      }
    } catch (e) {
      debugLog(`Error creating docker volume ${v.name}: ${e}`);
    }
  }
}

/** Run a command in a fresh container and return docker's result. */
async function launch(config: PiContainerConfig & RuntimeContext, command: string[]): Promise<SpawnSyncReturns<Buffer>> {
  buildIfNeeded(config);
  ensureVolumes(config);

  const envFile = writeEnvFile(config.env);
  try {
    const args = buildDockerRunArgs(config, command, { envFile: envFile?.path });
    debugLog(`Running: docker ${formatDockerArgs(args, config.env)}`);
    return await spawnDocker(args, config.debug);
  } finally {
    envFile?.remove();
  }
}

export async function runContainer(config: PiContainerConfig & RuntimeContext, piArgs: string[]): Promise<void> {
  debugLog("runContainer called with piArgs:", piArgs);
  const result = await launch(config, piArgs);

  debugLog(`Docker run exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    console.error(`Container exited with status ${result.status}`);
    process.exit(result.status);
  }
}

// ── Shell ───────────────────────────────────────────────────

export async function shellInContainer(config: PiContainerConfig & RuntimeContext): Promise<void> {
  debugLog("shellInContainer called");
  console.log("🐚 Opening shell in pi container...");
  const result = await launch(config, ["/bin/bash"]);

  debugLog(`Docker shell exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

/**
 * Open a shell in an existing container via docker exec.
 * Runs /bin/bash as pi-user so file permissions match the host.
 */
export async function execInContainer(containerId: string): Promise<void> {
  debugLog(`execInContainer called for: ${containerId}`);

  // Verify the container exists and is running
  const inspect = spawnSync("docker", ["container", "inspect", containerId], { stdio: "pipe" });
  if (inspect.status !== 0) {
    console.error(`Error: Container "${containerId}" not found.`);
    console.error(inspect.stderr.toString().trim());
    process.exit(1);
  }

  let containerData: any;
  try {
    containerData = JSON.parse(inspect.stdout.toString());
  } catch {
    console.error(`Error: Failed to inspect container "${containerId}".`);
    process.exit(1);
  }

  if (!containerData[0]?.State?.Running) {
    console.error(`Error: Container "${containerId}" is not running.`);
    process.exit(1);
  }

  console.log(`🐚 Opening shell in container ${containerId}...`);
  const isTTY = process.stdin.isTTY;
  const args = ["exec"];
  if (isTTY) {
    args.push("-it");
  } else {
    args.push("-i");
  }
  const containerUser = os.userInfo().username;
  args.push("-u", containerUser, containerId, "/bin/bash");

  debugLog(`Running: docker ${args.join(" ")}`);
  const result = await spawnDocker(args, false);

  debugLog(`Docker exec exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
}

// ── Docker run arg construction ──────────────────────────────

/**
 * Expand path variables so config files stay portable across users and machines:
 *   ~              →  host home directory (e.g. /Users/alice)
 *   ${home}        →  host home directory (e.g. /Users/alice)
 *   ${workspaceDir} →  absolute path of the mounted project directory
 */
function resolvePath(p: string, homeDir: string, workspaceDir: string): string {
  return p
    .replace(/^~/, homeDir)
    .replace(/\$\{home\}/g, homeDir)
    .replace(/\$\{workspaceDir\}/g, workspaceDir);
}

/**
 * Split docker.env into the entries Docker's --env-file format can carry and
 * the ones that must stay on the command line. The format is one KEY=value
 * per line with the value taken verbatim, so only line breaks in a value, or
 * a key the parser would misread, cannot be represented.
 */
export function partitionEnv(env: Record<string, string>): { file: Record<string, string>; inline: Record<string, string> } {
  const file: Record<string, string> = {};
  const inline: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    const value = String(raw);
    const representable = /^[^\s=#][^\s=]*$/.test(key) && !/[\r\n]/.test(value) &&
      Buffer.byteLength(key) + Buffer.byteLength(value) < 32 * 1024;
    (representable ? file : inline)[key] = value;
  }
  return { file, inline };
}

/**
 * Write the env-file-safe part of docker.env to a private temp file
 * (0600, inside a 0700 directory). Returns undefined when there is nothing
 * to write. The caller removes the file once docker has exited.
 */
export function writeEnvFile(env: Record<string, string>): { path: string; remove(): void } | undefined {
  const entries = Object.entries(partitionEnv(env).file);
  if (entries.length === 0) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-env-"));
  const file = path.join(dir, "env");
  fs.writeFileSync(file, entries.map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  // Also covers process.exit() paths that skip the caller's cleanup.
  process.once("exit", remove);
  // A signal's default action ends the process without an "exit" event, which
  // would leave the values on disk: clean up first, then let the signal act.
  const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = () => {
      remove();
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  return { path: file, remove };
}

/** Render docker arguments for logs, masking the values of docker.env entries. */
export function formatDockerArgs(args: string[], env: Record<string, string>): string {
  return args
    .map((arg, index) => {
      if (args[index - 1] !== "-e") return arg;
      const key = arg.split("=", 1)[0];
      return Object.hasOwn(env, key) && arg.includes("=") ? `${key}=***` : arg;
    })
    .join(" ");
}

export interface DockerRunOptions {
  /**
   * Env file holding docker.env (see writeEnvFile). Without it, every
   * docker.env entry is passed as -e KEY=value on the command line.
   */
  envFile?: string;
}

export function buildDockerRunArgs(
  config: PiContainerConfig & RuntimeContext,
  command: string[],
  options: DockerRunOptions = {}
): string[] {
  const args: string[] = ["run", "--rm"];

  // TTY: allocate if we're connected to a terminal
  const isTTY = process.stdin.isTTY;
  if (isTTY) {
    args.push("-it");
  } else {
    args.push("-i");
  }
  debugLog(`TTY mode: ${isTTY ? "-it (interactive terminal)" : "-i (non-TTY)"}`);

  // No --name flag — docker generates unique names, allowing
  // multiple wpi instances to run simultaneously.

  // Mount project directory (CWD → workspace dir named after the project)
  args.push("-v", `${config.projectDir}:${config.workspaceDir}:cached`);
  debugLog(`Mount: ${config.projectDir} -> ${config.workspaceDir}`);

  // Mount pi config directory (host → container).
  // Use the host home path so the in-container path matches (e.g. /Users/<user>/.pi).
  const containerHome = os.homedir();
  args.push("-v", `${config.configDir}:${containerHome}/.pi`);
  debugLog(`Mount: ${config.configDir} -> ${containerHome}/.pi`);

  // Environment variables from config. Prefer the env file so values stay off
  // the command line; only entries the file format cannot carry are inlined.
  debugLog(`Environment vars: ${Object.keys(config.env).length > 0 ? Object.keys(config.env).join(", ") : "(none)"}`);
  const env = partitionEnv(config.env);
  if (options.envFile && Object.keys(env.file).length > 0) {
    args.push("--env-file", options.envFile);
  }
  for (const [key, value] of Object.entries(options.envFile ? env.inline : config.env)) {
    args.push("-e", `${key}=${value}`);
  }

  // Git user info from config (used by entrypoint to set git config in container)
  if (config.gitUserName) {
    args.push("-e", `GIT_USER_NAME=${config.gitUserName}`);
    debugLog(`Passing GIT_USER_NAME: ${config.gitUserName}`);
  }
  if (config.gitUserEmail) {
    args.push("-e", `GIT_USER_EMAIL=${config.gitUserEmail}`);
    debugLog(`Passing GIT_USER_EMAIL: ${config.gitUserEmail}`);
  }

  // Port mappings (localhost only)
  if (config.ports.length > 0) {
    debugLog(`Port mappings: ${config.ports.map(p => `${p.host}:${p.container}`).join(", ")}`);
  }
  for (const port of config.ports) {
    args.push("-p", `127.0.0.1:${port.host}:${port.container}`);
  }

  // Working directory
  args.push("-w", config.workspaceDir);

  // Pass workspace dir to container (for extensions)
  args.push("-e", `WORKSPACE_DIR=${config.workspaceDir}`);

  // Host UID/GID for file permissions
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  args.push("-e", `HOST_UID=${uid}`);
  args.push("-e", `HOST_GID=${gid}`);
  debugLog(`Host UID=${uid}, GID=${gid}`);

  // Pass host username and home so the entrypoint creates a matching Linux user.
  // On macOS the username is e.g. "<user>" and the home is "/Users/<user>".
  const hostUsername = os.userInfo().username;
  const hostHome = os.homedir();
  args.push("-e", `HOST_USERNAME=${hostUsername}`);
  args.push("-e", `HOST_HOME=${hostHome}`);
  debugLog(`Host USERNAME=${hostUsername}, HOME=${hostHome}`);

  // Pass host home directory so extensions can resolve host paths
  // (e.g., for worktree paths that live under ~/.pi which is volume-mounted)
  args.push("-e", `PI_HOST_HOME=${hostHome}`);
  debugLog(`PI_HOST_HOME=${hostHome}`);

  // Custom volume mounts from config
  if (config.mounts.length > 0) {
    debugLog(`Custom mounts: ${config.mounts.map(m => `${m.host}:${m.container}${m.mode ? ":" + m.mode : ""}`).join(", ")}`);
  }
  for (const mount of config.mounts) {
    const host = resolvePath(mount.host, hostHome, config.workspaceDir);
    const container = resolvePath(mount.container, hostHome, config.workspaceDir);
    const mountSpec = `${host}:${container}${mount.mode ? ":" + mount.mode : ""}`;
    args.push("-v", mountSpec);
  }

  // Memory limits
  if (config.memory) {
    args.push("--memory", config.memory);
    debugLog(`Setting container memory limit: ${config.memory}`);
  }
  if (config.memorySwap) {
    args.push("--memory-swap", config.memorySwap);
    debugLog(`Setting container memory-swap limit: ${config.memorySwap}`);
  }

  // Named volumes (docker volumes)
  const mountPaths: string[] = [];
  if (config.volumes && config.volumes.length > 0) {
    const vols = config.volumes;
    debugLog(`Named volumes: ${vols.map(v => `${v.name}:${v.container}${v.mode ? ":" + v.mode : ""}`).join(", ")}`);
    for (const v of vols) {
      const container = resolvePath(v.container, hostHome, config.workspaceDir);
      const spec = `${v.name}:${container}${v.mode ? ":" + v.mode : ""}`;
      args.push("-v", spec);
      mountPaths.push(container);
    }
  }

  // Collect container paths for custom mounts so the entrypoint can adjust ownership.
  // Resolved like the mount itself: the entrypoint sees no ~ or ${home} placeholders.
  for (const m of config.mounts) {
    mountPaths.push(resolvePath(m.container, hostHome, config.workspaceDir));
  }

  if (mountPaths.length > 0) {
    // Pass a comma-separated list of mount container paths to the container
    args.push("-e", `PI_MOUNT_PATHS=${mountPaths.join(",")}`);
    debugLog(`Passing PI_MOUNT_PATHS: ${mountPaths.join(",")}`);
  }

  // Image
  args.push(config.piImage);

  // Command (pi or shell)
  args.push(...command);

  return args;
}

// ── Build context creation ───────────────────────────────────
//
// Writes the build inputs collected by image.ts to a temp directory
// for `docker build`.

function createBuildContext(piVersion: string, dockerfileExtension?: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-build-"));
  for (const file of collectBuildContext(piVersion, dockerfileExtension)) {
    const target = path.join(tmpDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  return tmpDir;
}
