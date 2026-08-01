#!/usr/bin/env node
// ============================================================
// wpi — Run Pi Coding Agent in Docker
// ============================================================
// Usage:
//   wpi                          # interactive session
//   wpi -- -p "Summarize this"   # print mode
//   wpi -- -r                     # resume session
//   wpi build                    # build/rebuild image
//   wpi shell                    # drop into container shell
//   wpi shell <container-id>     # exec into an existing container
//
// Port config precedence (highest wins):
//   1. CLI flags              (-p, --port)
//   2. User config            (~/.pi/wpi.yml)
//   3. Project config           (.pi/wpi.yml)
// ============================================================

import { loadConfig, getUserConfigPath, PI_VERSION, checkPortAvailable, setDebug, debugLog } from "./config";
import { buildImage, runContainer, shellInContainer, execInContainer, buildDockerRunArgs } from "./docker";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

function printHelp(): void {
  const userConfigPath = getUserConfigPath();
  console.log(`
Usage: wpi [command] [options] [-- PI_ARGS...]

Commands:
  (default)     Run pi in Docker (interactive session)
  build         Build or rebuild the Docker image
  shell [id]    Open a shell in a new container, or exec into an existing one by ID/name
  dry-run       Print resolved config and docker commands without executing

Options:
  --help, -h        Show this help
  --version         Show version
  --debug, -d       Enable debug logging
  --mode MODE       Runtime backend: docker (default) or host
                    Overrides runtime.mode in config for this run only
  -p, --port PORT   Publish container port to localhost (repeatable)
                    PORT can be a simple port (3000) or host:container (8080:3000)
All arguments after -- are passed to pi.

Examples:
  wpi                              # interactive session
  wpi --mode host                  # run natively on the host (Phase 3+)
  wpi -p 3000                      # expose port 3000
  wpi -p 8080:3000                # host 8080 → container 3000
  wpi -p 3000 -p 6006             # expose multiple ports
  wpi -- -p "Summarize"            # print mode
  wpi -- -r                        # resume session
  wpi build                        # build image
  wpi shell                        # container shell
  wpi shell my-container           # exec into an existing container

Port config precedence (highest wins):
  1. CLI flags (-p, --port)
  2. User config:    ${userConfigPath}
  3. Project config: .pi/wpi.yml

Config file schema:
  runtime:
    mode: docker        # docker | host (default: docker)
  pi:
    version: 0.76.0     # override the pi version used (default: baked-in)
  docker:
    ports:
      - 3000        # dev server
      - 6006        # storybook
      - 8080:80     # host 8080 → container 80
    mounts:
      - /var/run/docker.sock:/var/run/docker.sock  # docker socket
      - ~/.ssh:/home/pi-user/.ssh:ro                # ssh keys (read-only)
    env:
      CUSTOM_ENV: sk-xxx  # passed to the container
    memory: 4g
    extension: |
      RUN apt-get update && apt-get install -y python3  # extra image steps
  git:
    user:
      name: John Doe
      email: john@example.com

Path placeholders (usable in docker.mounts and docker.volumes):
  ~ or \${home}          host home directory  (e.g. /Users/alice)
  \${workspaceDir}        mounted project directory
`.trim());
}

function printVersion(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../package.json");
  console.log(`wpi ${pkg.version} (pi v${PI_VERSION})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Split on -- to separate our args from pi's args
  const dashDashIdx = args.indexOf("--");
  let ourArgs: string[];
  let piArgs: string[];
  if (dashDashIdx !== -1) {
    ourArgs = args.slice(0, dashDashIdx);
    piArgs = args.slice(dashDashIdx + 1);
  } else {
    ourArgs = args;
    piArgs = [];
  }

  // Parse our args
  let command: "run" | "build" | "shell" | "dry-run" = "run";
  let shellContainerId: string | undefined;
  const cliPorts: string[] = [];
  let cliMode: string | undefined;
  let cliDebug = false;

  for (let i = 0; i < ourArgs.length; i++) {
    const arg = ourArgs[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    }
    if (arg === "--version") {
      printVersion();
      return;
    }
    if (arg === "--debug" || arg === "-d") {
      cliDebug = true;
    } else if (arg === "-p" || arg === "--port") {
      const value = ourArgs[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(`Error: ${arg} requires a port argument.`);
        console.error("Example: wpi -p 3000 or wpi -p 8080:3000");
        process.exit(1);
      }
      cliPorts.push(value);
      i++; // skip the value
    } else if (arg === "--mode") {
      const value = ourArgs[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("Error: --mode requires a value (docker or host).");
        console.error("Example: wpi --mode host");
        process.exit(1);
      }
      cliMode = value;
      i++; // skip the value
    } else if (arg === "build") {
      command = "build";
    } else if (arg === "shell") {
      command = "shell";
      // Peek at next arg: if it's not a flag, treat it as a container ID
      const nextArg = ourArgs[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        shellContainerId = nextArg;
        i++; // skip the container ID
      }
    } else if (arg === "dry-run") {
      command = "dry-run";
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Run 'wpi --help' for usage.");
      process.exit(1);
    }
  }

  // Enable debug logging if requested
  if (cliDebug) {
    setDebug(true);
    debugLog("Debug mode enabled");
    debugLog("CLI args:", { ourArgs, piArgs, command });
  }

  // If shell was given a container ID, exec directly (no config needed)
  if (command === "shell" && shellContainerId) {
    // Check Docker is available
    try {
      const dockerVersion = execSync("docker --version", { stdio: "pipe" }).toString().trim();
      debugLog(`Docker found: ${dockerVersion}`);
    } catch (e) {
      debugLog("Docker check failed:", e);
      console.error("Error: Docker is not installed or not running.");
      console.error("Please install Docker and ensure it's accessible.");
      process.exit(1);
    }
    await execInContainer(shellContainerId);
    return;
  }

  // Check that Docker is available (skip for dry-run)
  if (command !== "dry-run") {
    try {
      const dockerVersion = execSync("docker --version", { stdio: "pipe" }).toString().trim();
      debugLog(`Docker found: ${dockerVersion}`);
    } catch (e) {
      debugLog("Docker check failed:", e);
      console.error("Error: Docker is not installed or not running.");
      console.error("Please install Docker and ensure it's accessible.");
      process.exit(1);
    }
  }

  // Load config from .pi/, user config
  debugLog("Loading config...");
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ cliPorts, cliMode, debug: cliDebug });
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  debugLog("Config loaded:", {
    runtimeMode: config.runtimeMode,
    ports: config.ports,
    envKeys: Object.keys(config.env),
    mounts: config.mounts,
    configDir: config.configDir,
    containerDir: config.containerDir || "(none)",
    projectDir: config.projectDir,
    workspaceDir: config.workspaceDir,
    dockerfileExtension: config.dockerfileExtension ? "(present)" : "(none)",
    debug: config.debug,
  });

  fs.mkdirSync(config.configDir + "/agent", { recursive: true });

  // Check port availability before running
  if ((command === "run" || command === "shell") && config.ports.length > 0) {
    debugLog(`Checking port availability for ${config.ports.length} port(s)...`);
    const conflicts = await checkPorts(config.ports);
    if (conflicts.length > 0) {
      console.error("Error: The following ports are already in use on localhost:");
      for (const { host } of conflicts) {
        console.error(`  - ${host}`);
      }
      console.error("");
      console.error("To fix, either:");
      console.error("  - Change the host port in .pi/wpi.yml (e.g., \"3001:3000\")");
      console.error("  - Stop the process using the port");
      process.exit(1);
    }
  }

  // Dispatch command
  debugLog(`Dispatching command: ${command}`);
  switch (command) {
    case "build":
      buildImage(config);
      break;
    case "shell":
      await shellInContainer(config);
      break;
    case "run":
      await runContainer(config, piArgs.length > 0 ? ["pi", ...piArgs] : ["pi"]);
      break;
    case "dry-run":
      printDryRun(config, piArgs);
      break;
  }
}

async function checkPorts(ports: { host: number; container: number }[]): Promise<{ host: number }[]> {
  const conflicts: { host: number }[] = [];
  for (const port of ports) {
    const available = await checkPortAvailable(port.host);
    if (!available) {
      conflicts.push({ host: port.host });
    }
  }
  return conflicts;
}

function printDryRun(config: ReturnType<typeof loadConfig>, piArgs: string[]): void {
  const userConfigPath = getUserConfigPath();
  const userConfigExists = fs.existsSync(userConfigPath);

  console.log("Configuration:");
  console.log(`  runtime mode:   ${config.runtimeMode}`);
  console.log(`  version:        ${config.piVersion}`);
  console.log(`  image:          ${config.piImage}`);
  console.log(`  projectDir:     ${config.projectDir}`);
  console.log(`  workspaceDir:   ${config.workspaceDir}`);
  console.log(`  configDir:      ${config.configDir}`);
  if (Object.keys(config.env).length > 0) {
    console.log("  env:");
    for (const [key, value] of Object.entries(config.env)) {
      console.log(`    ${key}: ${value}`);
    }
  } else {
    console.log(`  env:            (none)`);
  }
  if (config.ports.length > 0) {
    console.log("  ports:");
    for (const p of config.ports) {
      const arrow = p.host === p.container ? String(p.host) : `${p.host}:${p.container}`;
      console.log(`    ${arrow} → ${p.container} (localhost)`);
    }
  } else {
    console.log(`  ports:          (none)`);
  }
  if (config.dockerfileExtension) {
    console.log("  docker.extension: (present)");
  } else {
    console.log(`  docker.extension: (none)`);
  }
  console.log(`  git.userName:     ${config.gitUserName || "(inferred from host)"}`);
  console.log(`  git.userEmail:    ${config.gitUserEmail || "(inferred from host)"}`);
  if (config.mounts.length > 0) {
    console.log("  docker.mounts:");
    for (const m of config.mounts) {
      const spec = `${m.host}:${m.container}${m.mode ? ":" + m.mode : ""}`;
      console.log(`    ${spec}`);
    }
  } else {
    console.log(`  docker.mounts:    (none)`);
  }
  console.log();
  console.log("Config sources:");
  console.log(`  User config:    ${userConfigPath} ${userConfigExists ? "(found)" : "(not found)"}`);
  console.log(`  Project config: ${config.containerDir ? config.containerDir + "/wpi.yml" : "(no .pi dir)"}`);
  console.log();
  const cmd = piArgs.length > 0 ? ["pi", ...piArgs] : ["pi"];
  const runArgs = buildDockerRunArgs(config, cmd);
  console.log("Docker run command:");
  console.log(`  docker ${runArgs.join(" ")}`);
  console.log();
  const buildArgs = [
    "docker",
    "build",
    "--build-arg",
    `PI_VERSION=${config.piVersion}`,
    "-t",
    config.piImage,
    ".",
  ];
  console.log("Docker build command (would be run in temp build context):");
  console.log(`  ${buildArgs.join(" ")}`);
}

main();
