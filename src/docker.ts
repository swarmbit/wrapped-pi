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
// ============================================================

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync, spawn, SpawnSyncReturns } from "child_process";
import { PiContainerConfig, RuntimeContext, debugLog, isDebug } from "./config";
import { generateDockerfile, generateEntrypoint } from "./templates";

// Module root (sibling to dist/)
const MODULE_ROOT = path.join(__dirname, "..");

// ── Docker sandbox wrapping (Phase 4) ─────────────────────────
// When sandbox.backend == "nono" in docker mode, every `docker` CLI call in
// this module runs under `nono run --profile wpi-docker ... -- docker ...`.
// DockerBackend sets the prefix via setDockerSandboxPrefix() before dispatching
// build/run/shell; doctor and `wpi shell <id>` leave it empty ([] = direct).
let _dockerSandboxPrefix: string[] = [];

/** Set the nono prefix prepended to every docker invocation in this module. */
export function setDockerSandboxPrefix(prefix: string[]): void {
  _dockerSandboxPrefix = prefix;
}

/** Wrap a docker arg array with the active sandbox prefix, if any. */
function dockerSpawnArgs(args: string[]): { bin: string; args: string[] } {
  if (_dockerSandboxPrefix.length === 0) return { bin: "docker", args };
  return { bin: "nono", args: [..._dockerSandboxPrefix, "--", "docker", ...args] };
}

// ── Image management ────────────────────────────────────────

export function imageExists(tag: string): boolean {
  debugLog(`Checking if image exists: ${tag}`);
  const inspect = dockerSpawnArgs(["image", "inspect", tag]);
  const result = spawnSync(inspect.bin, inspect.args, { stdio: "pipe" });
  const exists = result.status === 0;
  debugLog(`Image ${tag} exists: ${exists}${exists ? "" : " (stderr: " + result.stderr.toString().trim() + ")"}`);
  return exists;
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

    const { bin: buildBin, args: buildArgs } = dockerSpawnArgs(args);
    debugLog(`Running: ${buildBin} ${buildArgs.join(" ")} (cwd: ${buildCtx})`);
    const result = spawnSync(buildBin, buildArgs, {
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
    const { bin, args: wrappedArgs } = dockerSpawnArgs(args);
    const result = spawnSync(bin, wrappedArgs, { stdio: "inherit" });
    return Promise.resolve(result);
  }

  // Debug path: inherit stdin (keep TTY working), pipe stdout/stderr for capture
  return new Promise((resolve) => {
    const { bin, args: wrappedArgs } = dockerSpawnArgs(args);
    const child = spawn(bin, wrappedArgs, {
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

export async function runContainer(config: PiContainerConfig & RuntimeContext, piArgs: string[]): Promise<void> {
  debugLog("runContainer called with piArgs:", piArgs);
  buildIfNeeded(config);

  // Ensure named docker volumes exist
  if (config.volumes && config.volumes.length > 0) {
    for (const v of config.volumes) {
      debugLog(`Ensuring docker volume exists: ${v.name}`);
      try {
        // `docker volume create` is idempotent — it will succeed if the volume exists
        const volCreate = dockerSpawnArgs(["volume", "create", v.name]);
        const res = spawnSync(volCreate.bin, volCreate.args, { stdio: isDebug() ? "pipe" : "ignore" });
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

  const args = buildDockerRunArgs(config, piArgs);
  debugLog(`Running: docker ${args.join(" ")}`);
  const result = await spawnDocker(args, config.debug);

  debugLog(`Docker run exited with status: ${result.status}${result.error ? ", error: " + result.error.message : ""}`);
  if (result.status !== 0 && result.status !== null) {
    console.error(`Container exited with status ${result.status}`);
    process.exit(result.status);
  }
}

// ── Shell ───────────────────────────────────────────────────

export async function shellInContainer(config: PiContainerConfig & RuntimeContext): Promise<void> {
  debugLog("shellInContainer called");
  buildIfNeeded(config);

  // Ensure named docker volumes exist
  if (config.volumes && config.volumes.length > 0) {
    for (const v of config.volumes) {
      debugLog(`Ensuring docker volume exists: ${v.name}`);
      try {
        const volCreate = dockerSpawnArgs(["volume", "create", v.name]);
        const res = spawnSync(volCreate.bin, volCreate.args, { stdio: isDebug() ? "pipe" : "ignore" });
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

  console.log("🐚 Opening shell in pi container...");
  const args = buildDockerRunArgs(config, ["/bin/bash"]);
  debugLog(`Running: docker ${args.join(" ")}`);
  const result = await spawnDocker(args, config.debug);

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
  const inspectArgs = dockerSpawnArgs(["container", "inspect", containerId]);
  const inspect = spawnSync(inspectArgs.bin, inspectArgs.args, { stdio: "pipe" });
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

export function buildDockerRunArgs(config: PiContainerConfig & RuntimeContext, command: string[]): string[] {
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

  // Environment variables from config
  debugLog(`Environment vars: ${Object.keys(config.env).length > 0 ? Object.keys(config.env).join(", ") : "(none)"}`);
  for (const [key, value] of Object.entries(config.env)) {
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

  // Collect container paths for custom mounts so the entrypoint can adjust ownership
  for (const m of config.mounts) {
    mountPaths.push(m.container);
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
// Creates a temp directory with everything needed for `docker build`:
//   - Dockerfile (generated from template)
//   - entrypoint.sh (generated from template)
//   - package/ (built-in, from installed module)
//   - settings/ (built-in, from installed module)

function createBuildContext(piVersion: string, dockerfileExtension?: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-build-"));

  // Generate Dockerfile
  const dockerfile = generateDockerfile(dockerfileExtension, piVersion);
  fs.writeFileSync(path.join(tmpDir, "Dockerfile"), dockerfile);

  // Generate entrypoint
  const entrypoint = generateEntrypoint();
  fs.writeFileSync(path.join(tmpDir, "entrypoint.sh"), entrypoint);

  // Copy built-in package (always present in installed module)
  const builtinPackageDir = path.join(MODULE_ROOT, "package");
  if (fs.existsSync(builtinPackageDir)) {
    copyDir(builtinPackageDir, path.join(tmpDir, "package"));
  } else {
    createPlaceholderPackage(tmpDir);
  }

  // Copy built-in settings (always present in installed module)
  const builtinSettingsDir = path.join(MODULE_ROOT, "settings");
  if (fs.existsSync(builtinSettingsDir)) {
    copyDir(builtinSettingsDir, path.join(tmpDir, "settings"));
  } else {
    createPlaceholderSettings(tmpDir);
  }

  return tmpDir;
}

function createPlaceholderPackage(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, "package", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "package", "themes"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "package", "extensions", ".gitkeep"), "");
  fs.writeFileSync(path.join(tmpDir, "package", "themes", ".gitkeep"), "");
  fs.writeFileSync(
    path.join(tmpDir, "package", "package.json"),
    JSON.stringify(
      {
        name: "wpi-defaults",
        version: "1.0.0",
        private: true,
        description: "No customizations",
        keywords: ["pi-package"],
        pi: {
          extensions: ["./extensions"],
          themes: ["./themes"],
        },
        peerDependencies: {
          "@earendil-works/pi-coding-agent": "*",
        },
      },
      null,
      2
    )
  );
}

function createPlaceholderSettings(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "settings", "default-settings.json"),
    JSON.stringify({ defaultThinkingLevel: "medium", autoCompact: true }, null, 2)
  );
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip node_modules — the Docker build runs npm install for the package
    if (entry.name === "node_modules") continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
