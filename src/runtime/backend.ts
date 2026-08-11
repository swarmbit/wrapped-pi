// ============================================================
// wpi — Runtime backend interface & factory
// ============================================================
// RuntimeBackend abstracts how pi is launched. cli.ts delegates all
// execution to a backend resolved from config.runtimeMode via
// resolveBackend():
//   - DockerBackend (runtime.mode: docker) — image build + container run,
//     optionally wrapped in nono (Phase 4).
//   - HostBackend   (runtime.mode: host)   — native pi, optionally wrapped
//     in nono (Phase 3).
// Both backends also implement doctor (Phase 2) and setup (Phase 6).
// ============================================================

import type { PiContainerConfig, RuntimeContext, RuntimeMode } from "../config";
import { DEFAULT_RUNTIME_MODE } from "../config";
import { DockerBackend } from "./docker-backend";
import { HostBackend } from "./host-backend";
import type { DoctorReport } from "./doctor";
import type { SetupReport } from "./setup";

/** The fully-resolved config shape passed to backends (= loadConfig's return type). */
export type ResolvedConfig = PiContainerConfig & RuntimeContext;

export interface RuntimeBackend {
  /** Inherent backend mode (docker). Used for diagnostics, not dispatch. */
  readonly mode: RuntimeMode;
  /**
   * Verify the backend's prerequisites are present (e.g. the docker CLI
   * is reachable, or nono+pi for host mode). Throws / exits on failure.
   * Runs after config load so the check is mode- and sandbox-aware.
   */
  checkPrerequisites(config: ResolvedConfig): void;
  /** Build/prepare the runtime environment (image build, etc.). */
  build(config: ResolvedConfig): void;
  /** Run the agent with the given pi arguments. Exits non-zero on failure. */
  run(config: ResolvedConfig, piArgs: string[]): Promise<void>;
  /** Open an interactive shell in a fresh environment. Exits non-zero on failure. */
  shell(config: ResolvedConfig): Promise<void>;
  /** Exec into an existing environment by container/instance ID. Exits non-zero on failure. */
  execShell(containerId: string): Promise<void>;
  /** Print backend-specific dry-run output (command preview). No execution. */
  dryRun(config: ResolvedConfig, piArgs: string[]): void;
  /**
   * Produce a mode-aware health report (Phase 2). Never exits on its own —
   * cli.ts renders the report and exits with report.exitCode (0 healthy,
   * 1 warn, 2 error).
   */
  doctor(config: ResolvedConfig): Promise<DoctorReport>;
  /**
   * Phase 6: provision artifacts (profiles, package wiring) and verify the
   * (mode, sandbox) combination is ready to run, step by step. WRITES the
   * artifacts a first build/run would write (doctor is read-only; setup is not).
   * Never exits on its own — cli.ts renders the report and exits with
   * report.exitCode (0 ready, 1 warn, 2 error).
   */
  setup(config: ResolvedConfig): Promise<SetupReport>;
}

/**
 * Resolve the backend for a runtime mode.
 * Both modes are implemented; the default branch is defensive only
 * (parseRuntimeMode rejects unknown modes at config load).
 */
export function resolveBackend(mode: RuntimeMode): RuntimeBackend {
  switch (mode) {
    case "docker":
      return new DockerBackend();
    case "host":
      return new HostBackend();
    default: {
      // Unreachable in normal flow: parseRuntimeMode rejects unknown modes
      // at config load. Defensive only.
      const _exhaustive: never = mode;
      void _exhaustive;
      throw new Error(`No backend implemented for runtime mode "${mode}".`);
    }
  }
}

/** Resolve the backend used when no config is loaded yet (e.g. `wpi shell <id>`). */
export function resolveDefaultBackend(): RuntimeBackend {
  return resolveBackend(DEFAULT_RUNTIME_MODE);
}