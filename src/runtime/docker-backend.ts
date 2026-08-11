// ============================================================
// wpi — DockerBackend (Phase 1 / Phase 4)
// ============================================================
// Implements RuntimeBackend for `runtime.mode: docker`. This is the
// sole execution path in Phase 1; cli.ts talks only to this backend.
//
// Docker operations (image build, container run/shell/exec, run-arg
// construction) remain in ../docker.ts and are exercised directly by
// docker.test.ts. DockerBackend delegates to them so behaviour stays
// byte-identical to pre-Phase-1 while cli.ts stops importing docker.ts.
//
// Phase 4 (sandbox axis): when sandbox.backend == "nono", every docker
// invocation runs under `nono run --profile wpi-docker ... -- docker ...`.
// The wpi-docker profile (src/runtime/docker-profile.ts) scopes the docker
// client's host-side footprint: daemon socket, ~/.pi, temp dirs, declared
// docker.mounts (read per mode). `setDockerSandboxPrefix` arms ../docker.ts
// for the duration of one dispatch; dry-run and doctor never arm it.
// ============================================================

import type { ResolvedConfig, RuntimeBackend } from "./backend";
import { RuntimeMode, debugLog } from "../config";
import {
  buildImage,
  runContainer,
  shellInContainer,
  execInContainer,
  buildDockerRunArgs,
  imageExists,
  setDockerSandboxPrefix,
} from "../docker";
import { execSync, spawnSync } from "child_process";
import type { DoctorReport, DoctorSection, DoctorStatus, DoctorCheck } from "./doctor";
import { buildReport, buildRuntimeSection, buildConfigurationSection } from "./doctor";
import { buildSetupReport, runSmoke, firstLine, type SetupReport, type SetupStep } from "./setup";
import {
  ensureWpiDockerProfile,
  wpiDockerProfilePath,
  serializeWpiDockerProfile,
  buildWpiDockerProfile,
  checkProfileGrants,
  type DockerProfileInput,
  type ProfileGrantCheck,
  type EnsureDockerProfileResult,
} from "./docker-profile";
import * as os from "os";
import * as fs from "fs";

const NONO_BINARY = "nono";

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
    // Sandbox prerequisites (docker+nono): nono binary must be installed.
    if (config.sandboxBackend === "nono" && !this.commandAvailable(NONO_BINARY)) {
      console.error(`Error: sandbox.backend is "nono" but nono is not installed.`);
      console.error(`Install:  curl -fsSL https://nono.sh/install.sh | sh`);
      console.error(`Opt out:  add \`sandbox: { backend: none }\` to ~/.pi/wpi.yml (unsandboxed — doctor will warn)`);
      process.exit(1);
    }
  }

  // ── Sandbox wrapping (Phase 4) ─────────────────────────────

  /** Build the nono prefix prepended to every docker call in this backend's dispatch. */
  private nonoPrefix(config: ResolvedConfig): string[] {
    return ["run", "--profile", config.nono.dockerProfile, "--allow-cwd", "--rollback"];
  }

  /** Build the DockerProfileInput from resolved config. */
  private buildDockerProfileInput(config: ResolvedConfig): DockerProfileInput {
    return {
      wpiVersion: this.wpiVersion(),
      homeDir: os.homedir(),
      dockerSocket: config.dockerSocket,
      mounts: config.mounts,
      profileName: config.nono.dockerProfile,
    };
  }

  /**
   * Ensure the wpi-docker profile + activate the sandbox prefix for the duration
   * of this dispatch. Only call from build/run/shell (not dry-run/doctor).
   * sandbox=none prints the same loud opt-out notice host mode prints.
   */
  private enableSandboxOrWarn(config: ResolvedConfig): void {
    if (config.sandboxBackend !== "nono") {
      console.error("⚠ docker mode is running UNSANDBOXED (sandbox.backend: none).");
      return;
    }
    const input = this.buildDockerProfileInput(config);
    const res = ensureWpiDockerProfile(input);
    if (res.drifted) {
      console.error(
        `⚠ ${config.nono.dockerProfile} profile drift: ${res.path} differs from canonical. ` +
          `Using the on-disk profile as-is (wpi never overwrites it). To regenerate, delete the file and re-run.`
      );
      // Fail fast: a drifted profile that misses a declared grant (daemon
      // socket or a docker.mount host path) would break the docker client at
      // runtime — surface it here with a clear fix instead of a nono denial.
      // (process.exit must stay OUTSIDE the try: it throws, and the catch
      // below only owns malformed-profile handling.)
      let missing: ProfileGrantCheck[] = [];
      try {
        const onDisk = JSON.parse(fs.readFileSync(res.path, "utf-8"));
        missing = checkProfileGrants(input, onDisk).filter((g) => !g.granted);
      } catch (e) {
        // Malformed on-disk profile: nono will reject it at launch with its own
        // error, which is more accurate than anything we can guess here.
        debugLog("enableSandboxOrWarn: could not read on-disk profile:", e);
      }
      if (missing.length > 0) {
        console.error(`Error: on-disk profile ${res.path} does not grant:`);
        for (const m of missing) {
          console.error(`  - ${m.kind}: ${m.path}`);
        }
        console.error(`This would break the docker client at runtime. Delete the profile to regenerate from config.`);
        process.exit(1);
      }
    }
    setDockerSandboxPrefix(this.nonoPrefix(config));
  }

  private wpiVersion(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../package.json").version;
  }

  private commandAvailable(bin: string): boolean {
    try {
      execSync(`${bin} --version`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // ── RuntimeBackend dispatch ────────────────────────────────

  build(config: ResolvedConfig): void {
    this.enableSandboxOrWarn(config);
    buildImage(config);
  }

  async run(config: ResolvedConfig, piArgs: string[]): Promise<void> {
    this.enableSandboxOrWarn(config);
    await runContainer(config, piArgs);
  }

  async shell(config: ResolvedConfig): Promise<void> {
    this.enableSandboxOrWarn(config);
    await shellInContainer(config);
  }

  async execShell(containerId: string): Promise<void> {
    // `wpi shell <id>` execs into an existing container: direct docker exec,
    // no sandbox prefix (the container is the sandbox boundary).
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

    if (config.sandboxBackend === "nono") {
      const prefix = this.nonoPrefix(config).join(" ");
      console.log("Docker run command (sandboxed by nono):");
      console.log(`  nono ${prefix} -- docker ${runArgs.join(" ")}`);
      console.log(`  profile: ${config.nono.dockerProfile} (extends default; scopes docker client)`);
      console.log(`  socket:  ${config.dockerSocket}`);
      if (config.mounts.length > 0) {
        console.log(`  mounts:  ${config.mounts.map((m) => m.host).join(", ")} (granted per mount mode)`);
      }
      console.log();

      console.log("Docker build command (sandboxed, would run in temp build context):");
      console.log(`  nono ${prefix} -- docker ${buildArgs.join(" ")}`);
      return;
    }

    console.log("Docker run command:");
    console.log(`  docker ${runArgs.join(" ")}`);
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
   * additionally provisions the wpi-docker profile, validates socket/mount
   * grants, and smoke-tests nono supervising the docker client. Writes the
   * profile (write-if-absent) — unlike doctor, setup is not read-only.
   */
  async setup(config: ResolvedConfig): Promise<SetupReport> {
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
        detail: "docker runs without nono — host-side socket/mount access unrestricted (opt-out)",
      });
      return buildSetupReport(config.runtimeMode, steps);
    }

    // docker+nono
    if (!this.commandAvailable(NONO_BINARY)) {
      steps.push({
        status: "error",
        label: "nono binary",
        detail: "not installed — `curl -fsSL https://nono.sh/install.sh | sh` (or add `sandbox: { backend: none }` to opt out)",
      });
      return buildSetupReport(config.runtimeMode, steps);
    }
    steps.push({ status: "ok", label: "nono binary", detail: this.nonoVersion() });

    // Derive the wpi-docker profile (write-if-absent; drift is reported).
    const input = this.buildDockerProfileInput(config);
    const profileRes = ensureWpiDockerProfile(input);
    steps.push(this.dockerProfileStep(profileRes));

    // Validate socket + mount grants against the profile on disk.
    try {
      const onDisk = JSON.parse(fs.readFileSync(profileRes.path, "utf-8"));
      const grants = checkProfileGrants(input, onDisk);
      const missing = grants.filter((g) => !g.granted);
      if (missing.length === 0) {
        const mounts = config.mounts.length > 0 ? `${config.mounts.length} mount(s), ` : "";
        steps.push({ status: "ok", label: "profile grants", detail: `${mounts}socket ${config.dockerSocket} — all granted` });
      } else {
        steps.push({
          status: "error",
          label: "profile grants",
          detail: `missing: ${missing.map((m) => `${m.kind} ${m.path}`).join(", ")} — delete ${profileRes.path} to regenerate`,
        });
      }
    } catch (e) {
      debugLog("setup: could not read on-disk profile:", e);
      steps.push({ status: "error", label: "profile grants", detail: `could not read ${profileRes.path}` });
    }

    // Smoke test: nono supervises the docker client end-to-end.
    const smoke = runSmoke(NONO_BINARY, [...this.nonoPrefix(config), "--", "docker", "--version"]);
    steps.push(
      smoke.ok
        ? { status: "ok", label: "smoke test", detail: `nono run --profile ${config.nono.dockerProfile} -- docker --version → ${firstLine(smoke.output)}` }
        : { status: "error", label: "smoke test", detail: smoke.output }
    );

    return buildSetupReport(config.runtimeMode, steps);
  }

  /** Step for the wpi-docker profile provisioning result. */
  private dockerProfileStep(res: EnsureDockerProfileResult): SetupStep {
    if (res.written) return { status: "ok", label: "wpi-docker profile", detail: `written to ${res.path}` };
    if (res.inSync) return { status: "ok", label: "wpi-docker profile", detail: `in sync (${res.path})` };
    return {
      status: "warn",
      label: "wpi-docker profile",
      detail: `drifted (${res.path}) — wpi won't overwrite; delete to regenerate`,
    };
  }

  private nonoVersion(): string {
    try {
      return execSync(`${NONO_BINARY} --version`, { stdio: "pipe" }).toString().trim();
    } catch {
      return "installed";
    }
  }

  // ── Doctor section builders (docker) ───────────────────────

  /**
   * Sandbox section. Phase 4: docker defaults to nono, so `none` is an explicit
   * opt-out (warn); nono checks the binary + profile grants (socket + mounts).
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
            detail: "docker runs without nono — host-side socket/mount access unrestricted",
          },
        ],
      };
    }

    const checks: DoctorCheck[] = [
      { status: "ok", label: "backend", detail: `nono (docker default)` },
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

    // Profile: path, drift, and grant coverage (socket + declared mounts).
    // doctor is read-only — never writes the profile here.
    const input = this.buildDockerProfileInput(config);
    const profilePath = wpiDockerProfilePath(input.homeDir, input.profileName);
    checks.push({ status: "info", label: "profile", detail: `${input.profileName} (${profilePath})` });

    if (!fs.existsSync(profilePath)) {
      checks.push({
        status: "info",
        label: "profile grants",
        detail: "profile not written yet — will be granted on first build/run",
      });
      return { name: "Sandbox", checks };
    }

    try {
      const onDiskRaw = fs.readFileSync(profilePath, "utf-8");
      const onDisk = JSON.parse(onDiskRaw);
      const canonical = serializeWpiDockerProfile(buildWpiDockerProfile(input));
      if (onDiskRaw === canonical) {
        checks.push({ status: "ok", label: "profile drift", detail: "in sync with config" });
      } else {
        checks.push({
          status: "warn",
          label: "profile drift",
          detail: "differs from canonical — wpi won't overwrite; delete to regenerate",
        });
      }
      for (const g of checkProfileGrants(input, onDisk)) {
        if (g.granted) {
          checks.push({ status: "ok", label: `grant ${g.kind}`, detail: g.path });
        } else {
          checks.push({
            status: "error",
            label: `grant ${g.kind}`,
            detail: `${g.path} — not granted by on-disk profile; delete ${profilePath} to regenerate`,
          });
        }
      }
    } catch (e) {
      debugLog("doctor: wpi-docker profile read failed:", e);
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
