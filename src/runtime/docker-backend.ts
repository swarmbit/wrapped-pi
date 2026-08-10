// ============================================================
// wpi — DockerBackend (Phase 1)
// ============================================================
// Implements RuntimeBackend for `runtime.mode: docker`. This is the
// sole execution path in Phase 1; cli.ts talks only to this backend.
//
// Docker operations (image build, container run/shell/exec, run-arg
// construction) remain in ../docker.ts and are exercised directly by
// docker.test.ts. DockerBackend delegates to them so behaviour stays
// byte-identical to pre-Phase-1 while cli.ts stops importing docker.ts.
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
} from "../docker";
import { execSync, spawnSync } from "child_process";
import type { DoctorReport, DoctorSection, DoctorStatus, DoctorCheck } from "./doctor";
import { buildReport, buildRuntimeSection, buildConfigurationSection } from "./doctor";

export class DockerBackend implements RuntimeBackend {
  readonly mode: RuntimeMode = "docker";

  checkPrerequisites(): void {
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

  build(config: ResolvedConfig): void {
    buildImage(config);
  }

  async run(config: ResolvedConfig, piArgs: string[]): Promise<void> {
    await runContainer(config, piArgs);
  }

  async shell(config: ResolvedConfig): Promise<void> {
    await shellInContainer(config);
  }

  async execShell(containerId: string): Promise<void> {
    await execInContainer(containerId);
  }

  dryRun(config: ResolvedConfig, piArgs: string[]): void {
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

  async doctor(config: ResolvedConfig): Promise<DoctorReport> {
    const sections: DoctorSection[] = [
      buildRuntimeSection(config.runtimeMode),
      this.buildPiSection(config),
      this.buildDockerSection(),
      buildConfigurationSection(config),
    ];
    return buildReport(config.runtimeMode, sections);
  }

  // ── Doctor: Docker-specific sections ────────────────────────

  private buildPiSection(config: ResolvedConfig): DoctorSection {
    const checks: DoctorSection extends never ? never : { status: import("./doctor").DoctorStatus; label: string; detail: string }[] = [];
    void checks; // placeholder removed below
    return this.assemblePiSection(config);
  }

  private assemblePiSection(config: ResolvedConfig): DoctorSection {
    const checks: { status: import("./doctor").DoctorStatus; label: string; detail: string }[] = [
      { status: "ok", label: "version", detail: config.piVersion },
    ];

    // Image presence — Docker-specific (uses `docker image inspect`).
    let imageStatus: import("./doctor").DoctorStatus = "ok";
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
    try {
      const cliVersion = execSync("docker --version", { stdio: "pipe" }).toString().trim();
      checks.push({ status: "ok", label: "docker cli", detail: cliVersion });
    } catch (e) {
      debugLog("doctor: docker cli check failed:", e);
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
    try {
      // `docker info --format` only succeeds when the daemon is reachable.
      const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        stdio: "pipe",
        timeout: 10_000,
      });
      if (result.status === 0 && result.stdout) {
        const serverVersion = result.stdout.toString().trim();
        checks.push({
          status: "ok",
          label: "docker daemon",
          detail: `running (server ${serverVersion || "unknown"})`,
        });
      } else {
        checks.push({
          status: "error",
          label: "docker daemon",
          detail: "not running — start Docker Desktop or the docker daemon",
        });
      }
    } catch (e) {
      debugLog("doctor: docker daemon check failed:", e);
      checks.push({
        status: "error", label: "docker daemon", detail: "not running" });
    }

    return { name: "Docker", checks };
  }
}
