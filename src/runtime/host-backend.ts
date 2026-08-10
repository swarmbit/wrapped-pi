// ============================================================
// wpi — HostBackend (Phase 3, slice 1)
// ============================================================
// Runs pi natively on the host, sandboxed by nono (the default) or
// unsandboxed when sandbox.backend == "none" (allowed, doctor warns).
//
// Slice 1 scope:
//   - checkPrerequisites: platform (Seatbelt/Landlock), nono binary
//     (only when sandbox=nono), pi binary.
//   - run:   nono run --profile wpi --allow-cwd --rollback -- pi <args>
//            (or bare `pi <args>` + unsandboxed notice when sandbox=none)
//   - shell: nono shell --profile wpi --allow-cwd   (or bare $SHELL)
//   - build: no image build; ensure pi present + wpi profile (if nono)
//   - execShell: error (host mode has no container IDs)
//   - dryRun: print the resolved command
//   - doctor: Runtime, Sandbox, Pi, Platform, Configuration
//
// Credential routes / network.* mapping / workspace.access fs-rule
// mapping / profile drift detection land in Phase 3 commit 2.
// ============================================================

import type { ResolvedConfig, RuntimeBackend } from "./backend";
import { RuntimeMode, SandboxBackend, debugLog } from "../config";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import {
  WPI_PROFILE_NAME,
  ensureWpiProfile,
  buildWpiProfile,
  serializeWpiProfile,
  wpiProfilePath,
  type ProfileInput,
  type EnsureProfileResult,
  credentialEnvVarNames,
} from "./profile";
import {
  buildReport,
  buildConfigurationSection,
  type DoctorReport,
  type DoctorSection,
  type DoctorCheck,
  type DoctorStatus,
} from "./doctor";

const PI_BINARY = "pi";
const NONO_BINARY = "nono";

export class HostBackend implements RuntimeBackend {
  readonly mode: RuntimeMode = "host";

  // ── Prerequisites ──────────────────────────────────────────

  checkPrerequisites(config: ResolvedConfig): void {
    // platform support for kernel sandboxing
    this.assertPlatformSupported();

    // pi binary is always required in host mode
    if (!this.commandAvailable(PI_BINARY)) {
      console.error(`Error: pi is not installed or not on PATH (host mode runs pi natively).`);
      console.error(`Install pi, then retry. (wpi uses the "${PI_BINARY}" binary.)`);
      process.exit(1);
    }

    if (config.sandboxBackend === "nono") {
      if (!this.commandAvailable(NONO_BINARY)) {
        console.error(`Error: sandbox.backend is "nono" but nono is not installed.`);
        console.error(`Install:  curl -fsSL https://nono.sh/install.sh | sh`);
        console.error(`Opt out:  add \`sandbox: { backend: none }\` to ~/.pi/wpi.yml (unsandboxed — doctor will warn)`);
        process.exit(1);
      }
    } else {
      // sandbox=none: allowed but loud. Don't fail the prereq check (user opted in),
      // but print a one-line notice so it's never silent.
      console.error("⚠ host mode is running UNSANDBOXED (sandbox.backend: none).");
    }
  }

  // ── Build / prepare ─────────────────────────────────────────

  build(config: ResolvedConfig): void {
    // Host mode has no image to build. Ensure prerequisites + the wpi profile
    // (when sandboxed). This keeps `wpi build --mode host` a useful no-op.
    this.checkPrerequisites(config);
    if (config.sandboxBackend === "nono") {
      this.ensureProfileOrWarn(config);
    }
    console.log(`✓ host mode ready (pi v${config.piVersion}, sandbox: ${config.sandboxBackend}) — no image build needed.`);
  }

  // ── Run ─────────────────────────────────────────────────────

  async run(config: ResolvedConfig, piArgs: string[]): Promise<void> {
    this.assertPortsOkForHost(config);

    // cli.ts prepends "pi" to piArgs (same contract as DockerBackend/docker.ts),
    // so piArgs is already the full command. Default to ["pi"] if empty.
    const cmd = piArgs.length > 0 ? piArgs : [PI_BINARY];

    if (config.sandboxBackend === "nono") {
      this.ensureProfileOrWarn(config);
      const args = this.buildNonoRunArgs(config, cmd);
      debugLog(`Running: ${NONO_BINARY} ${args.join(" ")}`);
      const code = await this.spawnInherit(args);
      if (code !== 0 && code !== null) {
        console.error(`nono run exited with status ${code}`);
        process.exit(code);
      }
      return;
    }

    // sandbox=none: bare pi, unsandboxed notice
    console.error("⚠ host mode is running UNSANDBOXED (sandbox.backend: none).");
    debugLog(`Running (unsandboxed): ${cmd.join(" ")}`);
    const code = await this.spawnInherit(cmd, PI_BINARY);
    if (code !== 0 && code !== null) {
      console.error(`pi exited with status ${code}`);
      process.exit(code);
    }
  }

  // ── Shell ───────────────────────────────────────────────────

  async shell(config: ResolvedConfig): Promise<void> {
    const shellBin = process.env.SHELL || "/bin/bash";

    if (config.sandboxBackend === "nono") {
      this.ensureProfileOrWarn(config);
      const args = this.buildNonoShellArgs(config);
      debugLog(`Running: ${NONO_BINARY} ${args.join(" ")}`);
      const code = await this.spawnInherit(args);
      if (code !== 0 && code !== null) {
        console.error(`nono shell exited with status ${code}`);
        process.exit(code);
      }
      return;
    }

    console.error("⚠ host shell is running UNSANDBOXED (sandbox.backend: none).");
    debugLog(`Running (unsandboxed): ${shellBin}`);
    const code = await this.spawnInherit([shellBin], shellBin);
    if (code !== 0 && code !== null) {
      process.exit(code);
    }
  }

  // ── ExecShell (docker-only) ─────────────────────────────────

  async execShell(_containerId: string): Promise<void> {
    console.error("Error: `wpi shell <id>` is a Docker-mode operation; host mode has no container IDs.");
    console.error("Use `wpi shell` (no ID) to open a sandboxed host shell.");
    process.exit(1);
  }

  // ── Dry run ─────────────────────────────────────────────────

  dryRun(config: ResolvedConfig, piArgs: string[]): void {
    const cmd = piArgs.length > 0 ? piArgs : [PI_BINARY];
    if (config.sandboxBackend === "nono") {
      const args = this.buildNonoRunArgs(config, cmd);
      console.log("Nono run command:");
      console.log(`  ${NONO_BINARY} ${args.join(" ")}`);
      console.log(`  profile: ${WPI_PROFILE_NAME} (extends nolabs-ai/pi)`);
      // Surface the profile-derived policy so users see what config mapping produced.
      const profile = buildWpiProfile(this.buildProfileInput(config));
      const net = profile.network as Record<string, unknown> | undefined;
      if (net) {
        const parts: string[] = [];
        if (net.block) parts.push("block");
        if (Array.isArray(net.allow_domain) && net.allow_domain.length) parts.push(`allow_domain[${net.allow_domain.length}]`);
        if (Array.isArray(net.credentials) && net.credentials.length) parts.push(`credentials[${net.credentials.length}]`);
        if (net.custom_credentials && Object.keys(net.custom_credentials as object).length) parts.push(`custom_credentials[${Object.keys(net.custom_credentials as object).length}]`);
        if (parts.length) console.log(`  network: ${parts.join(", ")}`);
      }
      const denied = profile.environment as Record<string, unknown> | undefined;
      if (denied && Array.isArray(denied.deny_vars) && (denied.deny_vars as string[]).length) {
        console.log(`  route-wins deny_vars: ${(denied.deny_vars as string[]).join(", ")}`);
      }
    } else {
      console.log("Host run command (unsandboxed):");
      console.log(`  ${cmd.join(" ")}`);
    }
  }

  // ── Doctor ──────────────────────────────────────────────────

  async doctor(config: ResolvedConfig): Promise<DoctorReport> {
    const sections: DoctorSection[] = [
      this.buildRuntimeSection(config.runtimeMode),
      this.buildSandboxSection(config.sandboxBackend),
      this.buildPiSection(),
      this.buildPlatformSection(),
      buildConfigurationSection(config),
    ];
    // Only surface the Profile section when nono is configured — docker uses no
    // authored nono profile. Reports drift + route coverage.
    if (config.sandboxBackend === "nono") {
      sections.splice(2, 0, this.buildProfileSection(config));
    }
    return buildReport(config.runtimeMode, sections);
  }

  // ── private helpers ─────────────────────────────────────────

  private wpiVersion(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../package.json").version;
  }

  /** Build the profile input from resolved config (host home for ~ expansion). */
  private buildProfileInput(config: ResolvedConfig): ProfileInput {
    const homeDir = os.homedir();
    const denied = credentialEnvVarNames(config.network.credentials, config.network.customCredentials);
    return {
      wpiVersion: this.wpiVersion(),
      homeDir,
      workspaceDir: config.workspaceDir,
      network: config.network,
      workspace: config.workspace,
      nono: config.nono,
      deniedEnvVars: denied,
    };
  }

  /**
   * Ensure the wpi profile is on disk; warn loudly on drift (never overwrite).
   * Returned result also feeds the doctor report in commit 2 (Drift check).
   */
  private ensureProfileOrWarn(config: ResolvedConfig): EnsureProfileResult {
    const res = ensureWpiProfile(this.buildProfileInput(config));
    if (res.drifted) {
      console.error(
        `⚠ wpi profile drift: ${res.path} differs from the canonical profile for your config. ` +
          `Using the on-disk profile as-is (wpi never overwrites it). ` +
          `To regenerate, delete the file and re-run.`
      );
    }
    return res;
  }

  private commandAvailable(bin: string): boolean {
    try {
      execSync(`${bin} --version`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private assertPlatformSupported(): void {
    const platform = os.platform();
    // Seatbelt (macOS) and Landlock (Linux) are the supported kernel sandbox backends.
    if (platform !== "darwin" && platform !== "linux") {
      console.error(`Error: host+nono mode requires macOS (Seatbelt) or Linux (Landlock); got platform "${platform}".`);
      process.exit(1);
    }
  }

  /**
   * Build `nono run` args for launching pi sandboxed.
   * `--allow-cwd` grants the workspace; `--rollback` enables atomic restore;
   * `--profile wpi` loads the wpi-authored profile (extends nolabs-ai/pi).
   * Ports become `--listen-port` (host:container mismatch is an error).
   */
  buildNonoRunArgs(config: ResolvedConfig, command: string[]): string[] {
    const args: string[] = ["run", "--profile", WPI_PROFILE_NAME, "--allow-cwd", "--rollback"];
    for (const port of this.hostListenPorts(config)) {
      args.push("--listen-port", String(port));
    }
    args.push("--", ...command);
    return args;
  }

  buildNonoShellArgs(config: ResolvedConfig): string[] {
    const args: string[] = ["shell", "--profile", WPI_PROFILE_NAME, "--allow-cwd", "--rollback"];
    for (const port of this.hostListenPorts(config)) {
      args.push("--listen-port", String(port));
    }
    return args;
  }

  /**
   * Ports in host mode: there is no port forwarding (the process binds directly).
   * A host:container mapping is meaningless without a container → error.
   * A simple port (host===container) becomes a `--listen-port` grant so the
   * sandboxed agent may bind it.
   */
  private hostListenPorts(config: ResolvedConfig): number[] {
    return config.ports.map((p) => p.host);
  }

  private assertPortsOkForHost(config: ResolvedConfig): void {
    for (const p of config.ports) {
      if (p.host !== p.container) {
        console.error(
          `Error: host:container port mapping "${p.host}:${p.container}" is not supported in host mode ` +
            "(there is no container to forward to). Use a simple port (e.g. \"3000\")."
        );
        process.exit(1);
      }
    }
  }

  /**
   * Spawn with inherited stdio (interactive TTY passthrough).
   * Bin defaults to NONO_BINARY; pass an explicit bin for the unsandboxed path.
   * Resolves to the child exit code (null on signal/error).
   */
  private spawnInherit(args: string[], bin: string = NONO_BINARY): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: "inherit" });
      child.on("close", (code) => resolve(code));
      child.on("error", (err) => {
        debugLog(`spawn error from ${bin}:`, err);
        resolve(1);
      });
    });
  }

  // ── Doctor section builders (host) ──────────────────────────

  private buildRuntimeSection(mode: RuntimeMode): DoctorSection {
    return {
      name: "Runtime",
      checks: [{ status: "ok", label: "mode", detail: mode }],
    };
  }

  private buildSandboxSection(sandbox: SandboxBackend): DoctorSection {
    if (sandbox === "nono") {
      const checks: DoctorCheck[] = [
        { status: "ok", label: "backend", detail: "nono" },
      ];
      if (this.commandAvailable(NONO_BINARY)) {
        let version = "installed";
        try {
          version = execSync(`${NONO_BINARY} --version`, { stdio: "pipe" }).toString().trim();
        } catch {
          /* keep "installed" */
        }
        checks.push({ status: "ok", label: "nono binary", detail: version });
      } else {
        checks.push({
          status: "error",
          label: "nono binary",
          detail: "not installed — `curl -fsSL https://nono.sh/install.sh | sh`",
        });
      }
      return { name: "Sandbox", checks };
    }
    // sandbox=none
    return {
      name: "Sandbox",
      checks: [
        { status: "ok", label: "backend", detail: "none (opt-out)" },
        {
          status: "warn",
          label: "unsandboxed",
          detail: "host mode runs without nono — kernel isolation off",
        },
      ],
    };
  }

  private buildPiSection(): DoctorSection {
    const checks: DoctorCheck[] = [];
    if (this.commandAvailable(PI_BINARY)) {
      let version = "installed";
      try {
        version = execSync(`${PI_BINARY} --version`, { stdio: "pipe" }).toString().trim();
      } catch {
        /* keep "installed" */
      }
      checks.push({ status: "ok", label: "pi binary", detail: version });
    } else {
      checks.push({
        status: "error",
        label: "pi binary",
        detail: `not installed or not on PATH (host mode needs "${PI_BINARY}")`,
      });
    }
    return { name: "Pi", checks };
  }

  /**
   * Profile section: reports the wpi-authored nono profile path, drift status, and
   * which credential routes are enabled (route wins → real keys denied in child).
   */
  private buildProfileSection(config: ResolvedConfig): DoctorSection {
    const checks: DoctorCheck[] = [];

    // Path presence
    const p = wpiProfilePath(os.homedir());
    if (fs.existsSync(p)) {
      checks.push({ status: "info", label: "path", detail: p });
    } else {
      checks.push({ status: "info", label: "path", detail: `${p} (will be written on first run)` });
    }

    // Drift: compare on-disk to canonical (write nothing; doctor is read-only).
    try {
      const canonical = serializeWpiProfile(buildWpiProfile(this.buildProfileInput(config)));
      const onDisk = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
      if (onDisk === null) {
        checks.push({ status: "info", label: "drift", detail: "no profile yet (canonical will be written)" });
      } else if (onDisk === canonical) {
        checks.push({ status: "ok", label: "drift", detail: "in sync with config" });
      } else {
        checks.push({
          status: "warn",
          label: "drift",
          detail: "profile differs from canonical — wpi won't overwrite; delete to regenerate",
        });
      }
    } catch (e) {
      debugLog("doctor: drift check failed:", e);
      checks.push({ status: "info", label: "drift", detail: "could not compute" });
    }

    // Credential routes enabled
    const routes = [
      ...config.network.credentials,
      ...Object.keys(config.network.customCredentials),
    ];
    if (routes.length > 0) {
      checks.push({
        status: "ok",
        label: "credential routes",
        detail: routes.join(", "),
      });
      // Route wins: warn about real secret keys still in docker.env that are
      // covered by a route (they'd leak into host+none; nono denies them in
      // host+nono).
      const covered = new Set<string>(
        credentialEnvVarNames(config.network.credentials, config.network.customCredentials)
      );
      const leaking = Object.keys(config.env).filter((k) => covered.has(k));
      for (const k of leaking) {
        checks.push({
          status: "warn",
          label: `env ${k}`,
          detail: `covered by credential route; ${
            config.sandboxBackend === "nono"
              ? "real key denied in sandbox, phantom injected"
              : "host+none leaks the real key — switch to nono"
          }`,
        });
      }
    } else {
      checks.push({ status: "info", label: "credential routes", detail: "(none)" });
    }

    return { name: "Profile", checks };
  }

  private buildPlatformSection(): DoctorSection {
    const platform = os.platform();
    const checks: DoctorCheck[] = [
      { status: "info", label: "platform", detail: platform },
    ];
    if (platform === "darwin") {
      checks.push({ status: "ok", label: "sandbox support", detail: "Seatbelt (macOS)" });
    } else if (platform === "linux") {
      checks.push({ status: "ok", label: "sandbox support", detail: "Landlock (Linux)" });
    } else {
      checks.push({
        status: "error",
        label: "sandbox support",
        detail: `unsupported platform for host+nono (need macOS or Linux, got ${platform})`,
      });
    }
    return { name: "Platform", checks };
  }
}
