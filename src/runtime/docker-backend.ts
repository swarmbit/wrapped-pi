// ============================================================
// wpi — DockerBackend (Phase 1 / Phase 4)
// ============================================================
// Implements RuntimeBackend for `runtime.mode: docker`. This is the
// sole execution path in Phase 1; cli.ts talks only to this backend.
//
// Docker operations (image build, container run/shell/exec, run-arg
// construction) remain in ../docker.ts. DockerBackend delegates to them
// so behaviour stays byte-identical to pre-Phase-1 while cli.ts stops
// importing docker.ts.
//
// Phase 4 (sandbox axis): when sandbox.backend == "nono", the docker
// client itself runs UNSANDBOXED on the host. Sandboxing moved inside
// the container: the image ships nono, and the entrypoint wraps pi with
// `nono run --profile wpi` (PI_SANDBOX=nono). The wpi profile — the same
// one host mode authors at ~/.config/nono/profiles/wpi.json — is ensured
// here before `docker run` and shared into the container via the mounted
// ~/.config/nono (container paths mirror host paths, so the profile
// content works in both places). There is no docker-specific profile.
// ============================================================

import type { ResolvedConfig, RuntimeBackend, SetupOptions } from "./backend";
import { RuntimeMode, debugLog } from "../config";
import {
  buildImage,
  runContainer,
  shellInContainer,
  execInContainer,
  buildDockerRunArgs,
  imageExists,
} from "../docker";
import { execSync, spawnSync } from "child_process";
import type { DoctorReport, DoctorSection, DoctorStatus, DoctorCheck } from "./doctor";
import { buildReport, buildRuntimeSection, buildConfigurationSection } from "./doctor";
import { buildSetupReport, type SetupReport, type SetupStep } from "./setup";
import {
  ensureWpiProfile,
  wpiProfilePath,
  serializeWpiProfile,
  buildWpiProfile,
  credentialEnvVarNames,
  type ProfileInput,
  type EnsureProfileResult,
} from "./profile";
import { isNonoPackWired } from "./nono-pack";
import { agentSettingsPath } from "./package-wiring";
import * as os from "os";
import * as fs from "fs";

export class DockerBackend implements RuntimeBackend {
  readonly mode: RuntimeMode = "docker";

  // ── Prerequisites ──────────────────────────────────────────

  checkPrerequisites(config: ResolvedConfig): void {
    try {
      const dockerVersion = execSync("docker --version", { stdio: "pipe" }).toString().trim();
      debugLog(`Docker found: ${dockerVersion}`);
    } catch (e) {
      debugLog("Docker check failed:", e);
      console.error("Error: Docker is not installed or not running.");
      console.error("Please install Docker and ensure it's accessible.");
      process.exit(1);
    }
    // No host-side nono requirement: for docker+nono, nono lives inside the
    // image and wraps pi at the entrypoint.
  }

  // ── Sandbox preparation (Phase 4, in-container nono) ──────

  /** Build the ProfileInput for the shared wpi profile (same as host mode). */
  private buildProfileInput(config: ResolvedConfig): ProfileInput {
    return {
      wpiVersion: this.wpiVersion(),
      homeDir: os.homedir(),
      workspaceDir: config.workspaceDir,
      network: config.network,
      workspace: config.workspace,
      nono: config.nono,
      deniedEnvVars: credentialEnvVarNames(config.network.credentials, config.network.customCredentials),
    };
  }

  /**
   * Ensure the shared wpi nono profile exists on the host so the mounted
   * ~/.config/nono carries it into the container. Warn on drift (never
   * overwrite — same contract as host mode). sandbox=none skips this and
   * prints the loud opt-out notice host mode prints.
   */
  private ensureProfileOrWarn(config: ResolvedConfig): void {
    if (config.sandboxBackend !== "nono") {
      console.error("⚠ docker mode is running UNSANDBOXED (sandbox.backend: none).");
      return;
    }
    const res = ensureWpiProfile(this.buildProfileInput(config));
    if (res.drifted) {
      console.error(
        `⚠ wpi profile drift: ${res.path} differs from canonical. ` +
          `Using the on-disk profile as-is (wpi never overwrites it). To regenerate, delete the file and re-run.`
      );
    }
  }

  private wpiVersion(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../package.json").version;
  }

  // ── RuntimeBackend dispatch ────────────────────────────────

  build(config: ResolvedConfig): void {
    this.ensureProfileOrWarn(config);
    buildImage(config);
  }

  async run(config: ResolvedConfig, piArgs: string[]): Promise<void> {
    this.ensureProfileOrWarn(config);
    await runContainer(config, piArgs);
  }

  async shell(config: ResolvedConfig): Promise<void> {
    this.ensureProfileOrWarn(config);
    await shellInContainer(config);
  }

  async execShell(containerId: string): Promise<void> {
    // `wpi shell <id>` execs into an existing container: direct docker exec
    // (the container is the sandbox boundary).
    await execInContainer(containerId);
  }

  dryRun(config: ResolvedConfig, piArgs: string[]): void {
    const cmd = piArgs.length > 0 ? ["pi", ...piArgs] : ["pi"];
    const runArgs = buildDockerRunArgs(config, cmd);

    const buildArgs = [
      "build",
      "--build-arg",
      `PI_VERSION=${config.piVersion}`,
      "-t",
      config.piImage,
      ".",
    ];

    console.log("Docker run command:");
    console.log(`  docker ${runArgs.join(" ")}`);
    if (config.sandboxBackend === "nono") {
      console.log("  sandbox: nono wraps pi inside the container (profile wpi, shared ~/.config/nono)");
    } else {
      console.log("  sandbox: none (unsandboxed)");
    }
    console.log();

    console.log("Docker build command (would be run in temp build context):");
    console.log(`  docker ${buildArgs.join(" ")}`);
  }

  async doctor(config: ResolvedConfig): Promise<DoctorReport> {
    const sections: DoctorSection[] = [
      buildRuntimeSection(config.runtimeMode),
      this.buildSandboxSection(config),
      this.buildPiSection(config),
      this.buildDockerSection(),
      buildConfigurationSection(config),
    ];
    return buildReport(config.runtimeMode, sections);
  }

  // ── Setup (Phase 6) ───────────────────────────────────────

  /**
   * `wpi setup` for docker mode. Verifies docker cli + daemon; for docker+nono
   * additionally ensures the shared wpi nono profile (used in-container). The
   * nolabs-ai/pi pack is pulled by the entrypoint on first run (shared
   * ~/.config/nono mount). Writes the profile (write-if-absent) — unlike
   * doctor, setup is not read-only.
   */
  async setup(config: ResolvedConfig, _options?: SetupOptions): Promise<SetupReport> {
    const steps: SetupStep[] = [];

    const cliVersion = this.dockerCliVersion();
    if (!cliVersion) {
      steps.push({ status: "error", label: "docker cli", detail: "not installed or not on PATH" });
      steps.push({ status: "error", label: "docker daemon", detail: "unreachable (docker cli missing)" });
      return buildSetupReport(config.runtimeMode, steps);
    }
    steps.push({ status: "ok", label: "docker cli", detail: cliVersion });

    const daemon = this.dockerDaemonDetail();
    if (daemon) {
      steps.push({ status: "ok", label: "docker daemon", detail: daemon });
    } else {
      steps.push({ status: "error", label: "docker daemon", detail: "not running — start Docker Desktop or the docker daemon" });
    }

    if (config.sandboxBackend === "none") {
      steps.push({
        status: "warn",
        label: "unsandboxed",
        detail: "docker runs without nono — opt-out",
      });
      return buildSetupReport(config.runtimeMode, steps);
    }

    // docker+nono: nono lives inside the image; the entrypoint wraps pi and
    // pulls the nolabs-ai/pi pack on first run. Host side only needs the
    // shared wpi profile written for the ~/.config/nono mount.
    steps.push({
      status: "info",
      label: "nono in container",
      detail: "baked into the image; entrypoint runs `nono run --profile wpi` around pi (pack pulled on first run)",
    });
    const profileRes = ensureWpiProfile(this.buildProfileInput(config));
    steps.push(this.profileStep(profileRes));

    return buildSetupReport(config.runtimeMode, steps);
  }

  /** Step for the shared wpi profile provisioning result. */
  private profileStep(res: EnsureProfileResult): SetupStep {
    if (res.written) return { status: "ok", label: "wpi profile", detail: `written to ${res.path}` };
    if (res.inSync) return { status: "ok", label: "wpi profile", detail: `in sync (${res.path})` };
    return {
      status: "warn",
      label: "wpi profile",
      detail: `drifted (${res.path}) — wpi won't overwrite; delete to regenerate`,
    };
  }

  // ── Doctor section builders (docker) ───────────────────────

  /**
   * Sandbox section. Phase 4: docker defaults to nono, so `none` is an
   * explicit opt-out (warn). nono checks the shared wpi profile (path +
   * drift) — the in-container nono binary and pack are image/entrypoint
   * concerns, surfaced as info.
   */
  private buildSandboxSection(config: ResolvedConfig): DoctorSection {
    if (config.sandboxBackend === "none") {
      return {
        name: "Sandbox",
        checks: [
          { status: "ok", label: "backend", detail: "none (opt-out)" },
          {
            status: "warn",
            label: "unsandboxed",
            detail: "docker runs without nono",
          },
        ],
      };
    }

    const checks: DoctorCheck[] = [
      { status: "ok", label: "backend", detail: "nono (in-container)" },
      { status: "info", label: "nono binary", detail: "baked into the image (entrypoint wraps pi)" },
      { status: "info", label: "pack", detail: "nolabs-ai/pi pulled by the entrypoint on first run" },
    ];

    // Shared wpi profile: path + drift (doctor is read-only — never writes).
    const input = this.buildProfileInput(config);
    const profilePath = wpiProfilePath(input.homeDir);
    checks.push({ status: "info", label: "profile", detail: `${profilePath} (shared with host mode)` });

    // The nolabs-ai/pi pack self-wires its pi extensions on pull (entrypoint);
    // surface when pi would miss /nono-status in the container.
    const wired = isNonoPackWired(agentSettingsPath(config.configDir), os.homedir());
    checks.push(
      wired
        ? { status: "ok", label: "nono pack wiring", detail: "pi wired to nolabs-ai/pi (/nono-status extension)" }
        : {
            status: "info",
            label: "nono pack wiring",
            detail: "not wired yet — the entrypoint wires it on first run (`nono pull`)",
          }
    );

    try {
      const canonical = serializeWpiProfile(buildWpiProfile(input));
      const onDisk = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf-8") : null;
      if (onDisk === null) {
        checks.push({ status: "info", label: "profile drift", detail: "not written yet — will be written on first build/run" });
      } else if (onDisk === canonical) {
        checks.push({ status: "ok", label: "profile drift", detail: "in sync with config" });
      } else {
        checks.push({
          status: "warn",
          label: "profile drift",
          detail: "differs from canonical — wpi won't overwrite; delete to regenerate",
        });
      }
    } catch (e) {
      debugLog("doctor: wpi profile read failed:", e);
      checks.push({ status: "info", label: "profile", detail: "could not read (malformed?)" });
    }

    return { name: "Sandbox", checks };
  }

  private buildPiSection(config: ResolvedConfig): DoctorSection {
    const checks: DoctorCheck[] = [
      { status: "ok", label: "version", detail: config.piVersion },
    ];

    // Image presence — Docker-specific (uses `docker image inspect`).
    let imageStatus: DoctorStatus = "ok";
    let imageDetail: string;
    try {
      if (imageExists(config.piImage)) {
        imageDetail = `built (${config.piImage})`;
      } else {
        imageStatus = "warn";
        imageDetail = `not built — run \`wpi build\` (will build on next run)`;
      }
    } catch (e) {
      // imageExists shells out to docker; if docker is unreachable, downgrade to info
      // so the Docker section's error is the authoritative one.
      imageStatus = "info";
      imageDetail = "could not check (docker unreachable)";
      debugLog("doctor: imageExists failed:", e);
    }
    checks.push({ status: imageStatus, label: "image", detail: imageDetail });

    return { name: "Pi", checks };
  }

  private buildDockerSection(): DoctorSection {
    const checks: DoctorCheck[] = [];

    // Docker CLI
    const cliVersion = this.dockerCliVersion();
    if (cliVersion) {
      checks.push({ status: "ok", label: "docker cli", detail: cliVersion });
    } else {
      debugLog("doctor: docker cli check failed");
      checks.push({
        status: "error",
        label: "docker cli",
        detail: "not installed or not on PATH",
      });
      // No point checking the daemon if the CLI is missing.
      checks.push({
        status: "error",
        label: "docker daemon",
        detail: "unreachable (docker cli missing)",
      });
      return { name: "Docker", checks };
    }

    // Docker daemon (requires the CLI to be present)
    const daemon = this.dockerDaemonDetail();
    if (daemon) {
      checks.push({ status: "ok", label: "docker daemon", detail: daemon });
    } else {
      checks.push({
        status: "error",
        label: "docker daemon",
        detail: "not running — start Docker Desktop or the docker daemon",
      });
    }

    return { name: "Docker", checks };
  }

  // ── Docker CLI / daemon probes (shared doctor + setup) ───

  /** `docker --version` output, or null when the CLI is missing. */
  private dockerCliVersion(): string | null {
    try {
      return execSync("docker --version", { stdio: "pipe" }).toString().trim();
    } catch (e) {
      debugLog("docker --version failed:", e);
      return null;
    }
  }

  /** `docker info` server version detail, or null when the daemon is unreachable. */
  private dockerDaemonDetail(): string | null {
    try {
      // `docker info --format` only succeeds when the daemon is reachable.
      const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        stdio: "pipe",
        timeout: 10_000,
      });
      if (result.status === 0 && result.stdout) {
        const serverVersion = result.stdout.toString().trim();
        return `running (server ${serverVersion || "unknown"})`;
      }
      return null;
    } catch (e) {
      debugLog("docker daemon check failed:", e);
      return null;
    }
  }
}
