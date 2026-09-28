// ============================================================
// wpi — HostBackend
// ============================================================
// Runs pi natively on the host, sandboxed by nono (the default) or
// unsandboxed when sandbox.backend == "none" (allowed, doctor warns).
//
//   - checkPrerequisites: platform (Seatbelt/Landlock), nono binary
//     (only when sandbox=nono), pi binary.
//   - run:   nono run --profile wpi --allow-cwd --rollback -- pi <args>
//            (or bare `pi <args>` + unsandboxed notice when sandbox=none)
//   - shell: nono shell --profile wpi --allow-cwd --rollback   (or bare $SHELL)
//   - build: no image build; ensure pi present + wpi profile (if nono)
//     + bundled package wiring (Phase 5)
//   - execShell: error (host mode has no container IDs)
//   - dryRun: print the resolved command
//   - doctor: Runtime, Sandbox, [Profile], Pi, Platform, Package, Configuration
//   - setup:  provision + verify the combination (Phase 6)
//
// Credential routes / network.* mapping / workspace fs grants / profile
// drift detection: src/runtime/profile.ts. Package copy + settings wiring:
// src/runtime/package-wiring.ts.
// ============================================================

import type { ResolvedConfig, RuntimeBackend, SetupOptions } from "./backend";
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
} from "./doctor";
import { buildSetupReport, runSmoke, firstLine, type SetupReport, type SetupStep } from "./setup";
import {
  ensurePackageWiring,
  compareWpiPackage,
  agentSettingsPath,
  wpiPackageDir,
  wpiPackageSourceDir,
  readNativeBinaries,
  readSettingsForDoctor,
  type WiringResult,
} from "./package-wiring";
import { isNonoPackWired } from "./nono-pack";
import * as path from "path";

const PI_BINARY = "pi";
const NONO_BINARY = "nono";

export class HostBackend implements RuntimeBackend {
  readonly mode: RuntimeMode = "host";

  /**
   * Injectable for tests: where the bundled package (package/) lives.
   * Defaults to the wpi npm package's package/ dir relative to this module.
   */
  private readonly packageSourceDir: string;

  constructor(options?: { packageSourceDir?: string }) {
    this.packageSourceDir = options?.packageSourceDir ?? wpiPackageSourceDir();
  }

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
    }
    // sandbox=none: allowed but loud. run()/shell() print the unsandboxed
    // notice at the moment of launch; prerequisites only fail on what is
    // actually missing, so the opt-out never blocks.
  }

  // ── Build / prepare ─────────────────────────────────────────

  build(config: ResolvedConfig): void {
    // Host mode has no image to build. Ensure prerequisites + the wpi profile
    // (when sandboxed) + the bundled package wiring. This keeps
    // `wpi build --mode host` a useful no-op.
    this.checkPrerequisites(config);
    if (config.sandboxBackend === "nono") {
      this.ensureProfileOrWarn(config);
    }
    this.ensurePackageWiringOrWarn(config);
    console.log(`✓ host mode ready (pi v${config.piVersion}, sandbox: ${config.sandboxBackend}) — no image build needed.`);
  }

  // ── Run ─────────────────────────────────────────────────────

  async run(config: ResolvedConfig, piArgs: string[]): Promise<void> {
    this.assertPortsOkForHost(config);
    this.ensurePackageWiringOrWarn(config);

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
    // cmd is the full command (bin first): spawn only its args, not "pi" itself.
    const code = await this.spawnInherit(cmd.slice(1), PI_BINARY);
    if (code !== 0 && code !== null) {
      console.error(`pi exited with status ${code}`);
      process.exit(code);
    }
  }

  // ── Shell ───────────────────────────────────────────────────

  async shell(config: ResolvedConfig): Promise<void> {
    this.assertPortsOkForHost(config);
    this.ensurePackageWiringOrWarn(config);
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
    const code = await this.spawnInherit([], shellBin);
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
    console.log(`  package: ${wpiPackageDir(os.homedir())} (wired on first run)`);
  }

  // ── Doctor ──────────────────────────────────────────────────

  async doctor(config: ResolvedConfig): Promise<DoctorReport> {
    const sections: DoctorSection[] = [
      this.buildRuntimeSection(config.runtimeMode),
      this.buildSandboxSection(config),
      this.buildPiSection(),
      this.buildPlatformSection(),
      this.buildPackageSection(config),
      buildConfigurationSection(config),
    ];
    // Only surface the Profile section when nono is configured — docker uses no
    // authored nono profile. Reports drift + route coverage.
    if (config.sandboxBackend === "nono") {
      sections.splice(2, 0, this.buildProfileSection(config));
    }
    return buildReport(config.runtimeMode, sections);
  }

  // ── Setup (Phase 6) ───────────────────────────────────────

  /**
   * `wpi setup` for host mode: platform → pi binary → (nono binary, pack,
   * wpi profile, package wiring, network, smoke test) or unsandboxed warning.
   * Writes the profile + package wiring (write-if-absent) — unlike doctor,
   * setup is not read-only. Missing binaries (pi, nono) can be installed
   * INTERACTIVELY: on a TTY (or with an injected prompt) setup asks [y/N]
   * and runs the exact install command; non-interactive runs only report
   * the command, never install silently.
   */
  async setup(config: ResolvedConfig, options?: SetupOptions): Promise<SetupReport> {
    const steps: SetupStep[] = [];

    // Platform support (Seatbelt / Landlock).
    const platform = os.platform();
    if (platform === "darwin" || platform === "linux") {
      steps.push({ status: "ok", label: "platform", detail: `${platform} (${platform === "darwin" ? "Seatbelt" : "Landlock"})` });
    } else {
      steps.push({
        status: "error",
        label: "platform",
        detail: `host mode requires macOS (Seatbelt) or Linux (Landlock); got "${platform}"`,
      });
      return buildSetupReport(config.runtimeMode, steps);
    }

    // pi binary (mandatory in host mode). Install pinned to the resolved
    // pi version — matches the docker image.
    const piNpmInstall = `npm install -g @earendil-works/pi-coding-agent@${config.piVersion}`;
    if (this.commandAvailable(PI_BINARY)) {
      steps.push({ status: "ok", label: "pi binary", detail: this.binVersion(PI_BINARY) });
    } else if (this.confirmInstall(`pi is not installed. Install @earendil-works/pi-coding-agent@${config.piVersion} via npm?`, options?.prompt)) {
      if (this.runInstall(piNpmInstall)) {
        steps.push({ status: "ok", label: "pi binary", detail: `installed via npm (v${config.piVersion})` });
      } else {
        steps.push({ status: "error", label: "pi binary", detail: `install failed — run \`${piNpmInstall}\` manually` });
        return buildSetupReport(config.runtimeMode, steps);
      }
    } else {
      steps.push({
        status: "error",
        label: "pi binary",
        detail: `not installed or not on PATH — ${piNpmInstall} (re-run setup in a terminal to install interactively)`,
      });
      return buildSetupReport(config.runtimeMode, steps);
    }

    if (config.sandboxBackend === "none") {
      steps.push({
        status: "warn",
        label: "unsandboxed",
        detail: "host mode runs without nono — kernel isolation off (explicit opt-out)",
      });
      return buildSetupReport(config.runtimeMode, steps);
    }

    // host+nono
    const nonoInstall = "curl -fsSL https://nono.sh/install.sh | sh";
    if (this.commandAvailable(NONO_BINARY)) {
      steps.push({ status: "ok", label: "nono binary", detail: this.binVersion(NONO_BINARY) });
    } else if (this.confirmInstall("nono is not installed. Install it via https://nono.sh/install.sh?", options?.prompt)) {
      if (this.runInstall(nonoInstall)) {
        steps.push({ status: "ok", label: "nono binary", detail: "installed via nono.sh/install.sh" });
      } else {
        steps.push({ status: "error", label: "nono binary", detail: `install failed — run \`${nonoInstall}\` manually` });
        return buildSetupReport(config.runtimeMode, steps);
      }
    } else {
      steps.push({
        status: "error",
        label: "nono binary",
        detail: `not installed — \`${nonoInstall}\` (or add \`sandbox: { backend: none }\` to opt out)`,
      });
      return buildSetupReport(config.runtimeMode, steps);
    }

    // nono pack the wpi profile extends (nolabs-ai/pi). Pulls when missing.
    steps.push(this.ensureNonoPack());

    // The pack self-wires its pi extensions into settings on pull; verify so
    // /nono-status and the nono-sandbox skill are actually reachable from pi.
    steps.push(this.nonoPackWiringStep(config));

    // Derive the wpi profile (write-if-absent; drift is reported).
    const profileRes = ensureWpiProfile(this.buildProfileInput(config));
    steps.push(this.hostProfileStep(profileRes));

    // Wire the bundled package (copy + settings entry).
    steps.push(this.packageWiringStep(config));

    // Network config surface (credentials / domains sanity).
    steps.push(this.networkStep(config));

    // Smoke test: nono supervises pi end-to-end.
    const smoke = runSmoke(NONO_BINARY, this.buildNonoRunArgs(config, [PI_BINARY, "--version"]));
    steps.push(
      smoke.ok
        ? { status: "ok", label: "smoke test", detail: `nono run --profile ${WPI_PROFILE_NAME} -- pi --version → ${firstLine(smoke.output)}` }
        : { status: "error", label: "smoke test", detail: smoke.output }
    );

    return buildSetupReport(config.runtimeMode, steps);
  }

  /** Ensure the nolabs-ai/pi pack the wpi profile extends is installed. */
  private ensureNonoPack(): SetupStep {
    try {
      const installed = execSync(`${NONO_BINARY} list --installed`, { stdio: "pipe", encoding: "utf-8" });
      if (installed.includes("nolabs-ai/pi")) {
        return { status: "ok", label: "nono pack", detail: "nolabs-ai/pi installed" };
      }
    } catch (e) {
      debugLog("setup: nono list --installed failed:", e);
    }
    // Missing (or unreadable): pull the signed pack. Idempotent, no sudo.
    const pull = runSmoke(NONO_BINARY, ["pull", "nolabs-ai/pi"], 60_000);
    if (pull.ok) return { status: "ok", label: "nono pack", detail: "pulled nolabs-ai/pi" };
    return { status: "error", label: "nono pack", detail: `pull failed: ${pull.output}` };
  }

  /** Step for the wpi profile provisioning result. */
  /** Step for the wpi profile provisioning result. */
  private hostProfileStep(res: EnsureProfileResult): SetupStep {
    if (res.written) return { status: "ok", label: "wpi profile", detail: `written to ${res.path}` };
    if (res.inSync) return { status: "ok", label: "wpi profile", detail: `in sync (${res.path})` };
    return {
      status: "warn",
      label: "wpi profile",
      detail: `drifted (${res.path}) — wpi won't overwrite; delete to regenerate`,
    };
  }

  /** Step for the nolabs-ai/pi pack's self-wiring into pi settings. */
  private nonoPackWiringStep(config: ResolvedConfig): SetupStep {
    const wired = isNonoPackWired(agentSettingsPath(config.configDir), os.homedir());
    if (wired) {
      return { status: "ok", label: "nono pack wiring", detail: "pi wired to nolabs-ai/pi (/nono-status extension)" };
    }
    return {
      status: "warn",
      label: "nono pack wiring",
      detail: "pack installed but not wired into pi settings — run `nono pull nolabs-ai/pi`",
    };
  }

  /** Step for the package copy + settings wiring result. */
  private packageWiringStep(config: ResolvedConfig): SetupStep {
    const wiring = ensurePackageWiring(this.packageSourceDir, os.homedir(), agentSettingsPath(config.configDir));
    if (wiring.wire?.action === "skipped-malformed") {
      return {
        status: "error",
        label: "package wiring",
        detail: `${agentSettingsPath(config.configDir)} is not valid JSON — fix it and re-run setup`,
      };
    }
    const copyDetail =
      wiring.copy.action === "copied"
        ? "copied"
        : wiring.copy.action === "upgraded"
        ? `replaced (${wiring.copy.differing.length} file(s) changed)`
        : "in sync";
    const wireDetail = wiring.wire?.action === "already" ? "settings already wired" : "settings wired";
    return { status: "ok", label: "package wiring", detail: `${wiring.copy.path} (${copyDetail}); ${wireDetail}` };
  }

  /** Surface the resolved network config; warn when filtered blocks everything. */
  private networkStep(config: ResolvedConfig): SetupStep {
    const creds = [...config.network.credentials, ...Object.keys(config.network.customCredentials)];
    const domains = config.network.allowDomains;
    if (config.network.mode === "filtered" && domains.length === 0 && creds.length === 0) {
      return {
        status: "warn",
        label: "network",
        detail: "mode=filtered with no allowDomains or credentials — outbound API calls will be blocked",
      };
    }
    const parts: string[] = [`mode=${config.network.mode}`];
    if (creds.length > 0) parts.push(`credentials: ${creds.join(", ")}`);
    if (domains.length > 0) parts.push(`allowDomains: ${domains.length} (${domains.join(", ")})`);
    if (parts.length === 1) parts.push("open (no restrictions)");
    return { status: "ok", label: "network", detail: parts.join("; ") };
  }

  private binVersion(bin: string): string {
    try {
      return execSync(`${bin} --version`, { stdio: "pipe" }).toString().trim();
    } catch {
      return "installed";
    }
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

  /**
   * Phase 5: wire the bundled pi package for host mode — fixed copy at
   * ~/.pi/.wpi/package + settings.json packages entry. Idempotent. The copy
   * is disposable wpi-owned state and is replaced wholesale when the bundled
   * source changes.
   */
  private ensurePackageWiringOrWarn(config: ResolvedConfig): WiringResult {
    const res = ensurePackageWiring(this.packageSourceDir, os.homedir(), agentSettingsPath(config.configDir));
    if (res.copy.action === "upgraded") {
      console.log(
        `✓ replaced bundled package at ${res.copy.path} (${res.copy.differing.length} file(s) changed)`
      );
    }
    if (res.wire?.action === "added") {
      console.log(`✓ wired bundled package ${res.wire.packagePath}`);
    } else if (res.wire?.action === "skipped-malformed") {
      console.error(
        `⚠ not wiring bundled package: ${agentSettingsPath(config.configDir)} exists but is not valid JSON. ` +
          `Fix it, then re-run.`
      );
    }
    return res;
  }

  /**
   * Doctor's Package section (host mode, read-only): reports the fixed copy
   * state, settings wiring state, and manifest-declared native binaries.
   */
  private buildPackageSection(config: ResolvedConfig): DoctorSection {
    const checks: DoctorCheck[] = [];
    const homeDir = os.homedir();
    const pkgDir = wpiPackageDir(homeDir);
    const settingsPath = agentSettingsPath(config.configDir);

    checks.push({ status: "info", label: "path", detail: pkgDir });

    // Fixed copy state (read-only — compare, never write).
    if (!fs.existsSync(this.packageSourceDir)) {
      checks.push({ status: "info", label: "package copy", detail: `bundled package not found at ${this.packageSourceDir}` });
    } else {
      const compare = compareWpiPackage(this.packageSourceDir, pkgDir);
      if (compare.state === "missing") {
        checks.push({ status: "info", label: "package copy", detail: "not present — will be copied on first run/build" });
      } else if (compare.state === "in-sync") {
        checks.push({ status: "ok", label: "package copy", detail: "in sync with bundled package" });
      } else {
        checks.push({
          status: "info",
          label: "package copy",
          detail: `stale (${compare.differing.length} file(s) differ) — will be replaced on next run`,
        });
      }
    }

    // Settings wiring state (read-only; doctor never writes).
    if (!fs.existsSync(settingsPath)) {
      checks.push({ status: "info", label: "settings", detail: `${settingsPath} (will be created on first run)` });
    } else {
      const settings = readSettingsForDoctor(settingsPath);
      if (settings === null) {
        checks.push({ status: "warn", label: "settings", detail: `${settingsPath} exists but is not valid JSON — not wiring` });
      } else {
        const packages = Array.isArray(settings.packages) ? settings.packages : [];
        const wired = packages.some(
          (p) => typeof p === "string" && path.resolve(path.dirname(settingsPath), p) === pkgDir
        );
        checks.push(
          wired
            ? { status: "ok", label: "settings", detail: `${settingsPath} (package wired)` }
            : { status: "info", label: "settings", detail: `${settingsPath} (will wire on first run)` }
        );
      }
    }

    // Manifest-declared native binaries (docker mode bakes them into the image;
    // host mode needs them on PATH — docker.extension in host mode already warns).
    const bins = readNativeBinaries(this.packageSourceDir);
    if (bins.length === 0) {
      checks.push({ status: "ok", label: "native binaries", detail: "(none declared)" });
    } else {
      for (const bin of bins) {
        if (this.commandAvailable(bin)) {
          checks.push({ status: "ok", label: `binary ${bin}`, detail: "found on PATH" });
        } else {
          checks.push({
            status: "error",
            label: `binary ${bin}`,
            detail: `not found on PATH — a bundled extension requires it`,
          });
        }
      }
    }

    return { name: "Package", checks };
  }

  private commandAvailable(bin: string): boolean {
    try {
      execSync(`${bin} --version`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ask whether to install a missing dependency. Uses the injected prompt in
   * tests; otherwise prompts on a TTY ([y/N]) and declines silently in
   * non-interactive runs — installs never happen without confirmation.
   */
  private confirmInstall(question: string, prompt?: (q: string) => boolean): boolean {
    if (prompt) return prompt(question);
    if (!process.stdin.isTTY) return false;
    try {
      const buf = Buffer.alloc(1);
      process.stderr.write(question + " [y/N] ");
      const n = fs.readSync(0, buf, 0, 1, null);
      process.stderr.write("\n");
      return n > 0 && ["y", "yes"].includes(buf.toString("utf-8").trim().toLowerCase());
    } catch {
      return false;
    }
  }

  /** Run an install command interactively (progress visible). True on success. */
  private runInstall(cmd: string): boolean {
    try {
      execSync(cmd, { stdio: "inherit" });
      return true;
    } catch (e) {
      debugLog("install command failed:", e);
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

  private buildSandboxSection(config: ResolvedConfig): DoctorSection {
    const sandbox = config.sandboxBackend;
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
      // The nolabs-ai/pi pack self-wires its pi extensions on pull; surface when
      // pi would miss /nono-status even with the pack installed.
      const wired = isNonoPackWired(agentSettingsPath(config.configDir), os.homedir());
      checks.push(
        wired
          ? { status: "ok", label: "nono pack wiring", detail: "pi wired to nolabs-ai/pi (/nono-status extension)" }
          : {
              status: "info",
              label: "nono pack wiring",
              detail: "not wired — run `nono pull nolabs-ai/pi`",
            }
      );
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
