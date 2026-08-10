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
} from "../docker";
import { execSync } from "child_process";

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
}
