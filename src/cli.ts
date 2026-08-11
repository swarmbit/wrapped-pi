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
import { resolveBackend, resolveDefaultBackend, type RuntimeBackend, type ResolvedConfig } from "./runtime/backend";
import { renderDoctorReport } from "./runtime/doctor";
import { renderSetupReport } from "./runtime/setup";
import * as fs from "fs";

function printHelp(): void {
  const userConfigPath = getUserConfigPath();
  console.log(`
Usage: wpi [command] [options] [-- PI_ARGS...]

Commands:
  (default)     Run pi in Docker (interactive session)
  build         Build or rebuild the Docker image
  shell [id]    Open a shell in a new container, or exec into an existing one by ID/name
  dry-run       Print resolved config and docker commands without executing
  doctor        Check runtime/docker/config health (exit 0 healthy, 1 warn, 2 error)
  setup         Provision and verify the current runtime/sandbox combination
                (exit 0 ready, 1 warn, 2 error)

Options:
  --help, -h        Show this help
  --version         Show version
  --debug, -d       Enable debug logging
  --mode MODE       Runtime backend: docker (default) or host
                    Overrides runtime.mode in config for this run only
  --sandbox BACKEND Sandbox backend: nono or none
                    Defaults to nono on BOTH modes (docker + host);
                    none is the explicit opt-out (doctor warns)
                    Overrides sandbox.backend in config for this run only
  -p, --port PORT   Publish container port to localhost (repeatable)
                    PORT can be a simple port (3000) or host:container (8080:3000)
All arguments after -- are passed to pi.

Examples:
  wpi                              # interactive session
  wpi --mode host                  # run natively on the host under nono
  wpi --mode host --sandbox none   # run natively, unsandboxed (doctor warns)
  wpi -p 3000                      # expose port 3000
  wpi -p 8080:3000                # host 8080 → container 3000
  wpi -p 3000 -p 6006             # expose multiple ports
  wpi -- -p "Summarize"            # print mode
  wpi -- -r                        # resume session
  wpi build                        # build image
  wpi shell                        # container shell
  wpi shell my-container           # exec into an existing container
  wpi doctor                       # health check (runtime/docker/config)
  wpi setup                        # provision + verify (docker+nono default)
  wpi setup --mode host            # host+nono: profile, pack, package, smoke test

Port config precedence (highest wins):
  1. CLI flags (-p, --port)
  2. User config:    ${userConfigPath}
  3. Project config: .pi/wpi.yml

Config file schema:
  runtime:
    mode: docker        # docker | host (default: docker)
  sandbox:
    backend: nono       # nono | none (default: nono on both modes; none = opt-out)
  pi:
    version: 0.76.0     # override the pi version used (default: baked-in)
  docker:
    socket: /var/run/docker.sock  # daemon socket (docker+nono grants this in the sandbox profile)
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
  network:            # host+nono only (Phase 3)
    mode: filtered    # filtered (default) | open | blocked
    allowDomains:
      - api.anthropic.com
      - github.com
    credentials: [anthropic, github]   # preset services; real keys stay in the supervisor
    customCredentials:                  # non-preset APIs (e.g. Firecrawl)
      firecrawl:
        upstream: https://api.firecrawl.dev
        credentialKey: firecrawl_api_key   # keyring name | env://VAR | op://…
        envVar: FIRECRAWL_API_KEY
        injectHeader: Authorization
        credentialFormat: "Bearer {}"
  workspace:          # extra fs grants beyond read-write workdir (host+nono)
    allowPaths: [~/src]
    readPaths: [/etc]
  nono:               # profile tuning
    allowPaths: [/tmp/build]
    readPaths: [~/.config]
    dockerProfile: wpi-docker  # nono profile used when sandboxing docker mode

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
  let command: "run" | "build" | "shell" | "dry-run" | "doctor" | "setup" = "run";
  let shellContainerId: string | undefined;
  const cliPorts: string[] = [];
  let cliMode: string | undefined;
  let cliSandbox: string | undefined;
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
    } else if (arg === "--sandbox") {
      const value = ourArgs[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("Error: --sandbox requires a value (nono or none).");
        console.error("Example: wpi --mode host --sandbox none");
        process.exit(1);
      }
      cliSandbox = value;
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
    } else if (arg === "doctor") {
      command = "doctor";
    } else if (arg === "setup") {
      command = "setup";
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

  // If shell was given a container ID, exec directly into it (no config needed).
  // `wpi shell <id>` is a docker exec against an existing container, so it uses
  // the default (docker) backend regardless of runtime mode.
  if (command === "shell" && shellContainerId) {
    const execBackend = resolveDefaultBackend();
    execBackend.checkPrerequisites({} as ResolvedConfig); // docker exec ignores config
    await execBackend.execShell(shellContainerId);
    return;
  }

  // (Prerequisite check runs after config load below, so it is mode- and
  // sandbox-aware.)

  // Load config from .pi/, user config
  debugLog("Loading config...");
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ cliPorts, cliMode, cliSandbox, debug: cliDebug });
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

  // Ensure the agent config dir exists for commands that actually launch pi.
  // doctor is read-only and must not create directories; dry-run preserves its
  // pre-existing behavior of ensuring the dir.
  if (command !== "doctor") {
    fs.mkdirSync(config.configDir + "/agent", { recursive: true });
  }

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

  // Resolve the runtime backend from config.runtimeMode for dispatch.
  const backend: RuntimeBackend = resolveBackend(config.runtimeMode);

  // Mode- and sandbox-aware prerequisite check (host+nono needs nono+pi,
  // docker needs docker). Skipped for dry-run (read-only), doctor (runs
  // its own checks) and setup (reports each prerequisite as a step). Runs
  // after config load so it knows runtimeMode+sandbox.
  if (command !== "dry-run" && command !== "doctor" && command !== "setup") {
    backend.checkPrerequisites(config as ResolvedConfig);
  }

  // Dispatch command
  debugLog(`Dispatching command: ${command}`);
  switch (command) {
    case "build":
      backend.build(config);
      break;
    case "shell":
      await backend.shell(config);
      break;
    case "run":
      await backend.run(config, piArgs.length > 0 ? ["pi", ...piArgs] : ["pi"]);
      break;
    case "dry-run":
      printDryRun(config, piArgs, backend);
      break;
    case "doctor": {
      const report = await backend.doctor(config as ResolvedConfig);
      console.log(renderDoctorReport(report));
      process.exit(report.exitCode);
      break;
    }
    case "setup": {
      const report = await backend.setup(config as ResolvedConfig);
      console.log(renderSetupReport(report));
      process.exit(report.exitCode);
      break;
    }
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

function printDryRun(config: ReturnType<typeof loadConfig>, piArgs: string[], backend: RuntimeBackend): void {
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
  // Backend-specific command preview (DockerBackend prints the docker run/build
  // commands). Host mode will render its own commands here in Phase 3.
  backend.dryRun(config as ResolvedConfig, piArgs);
}

main();
