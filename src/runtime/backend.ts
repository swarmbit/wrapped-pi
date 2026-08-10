// ============================================================
// wpi — Runtime backend interface & factory (Phase 1)
// ============================================================
// RuntimeBackend abstracts how pi is launched. cli.ts delegates all
// execution to a backend resolved from config.runtimeMode via
// resolveBackend().
//
// Phase 1 scope (per docs/dual-mode-implementation-plan.md):
//   - Only DockerBackend exists.
//   - Host mode is accepted (parsed in Phase 0) but still dispatches
//     to the Docker backend, preserving the documented Phase 0
//     limitation: "--mode host for run/build/shell still executes the
//     Docker backend ... Dispatch lands in Phase 1 (RuntimeBackend
//     factory)." The factory lands here; HostBackend lands in Phase 3.
//
// Exit criteria: npm test green; wpi dry-run output byte-identical
// to main (only the Phase 0 "runtime mode:" line differs).
// ============================================================

import type { PiContainerConfig, RuntimeContext, RuntimeMode } from "../config";
import { DEFAULT_RUNTIME_MODE } from "../config";
import { DockerBackend } from "./docker-backend";

/** The fully-resolved config shape passed to backends (= loadConfig's return type). */
export type ResolvedConfig = PiContainerConfig & RuntimeContext;

export interface RuntimeBackend {
  /** Inherent backend mode (docker). Used for diagnostics, not dispatch. */
  readonly mode: RuntimeMode;
  /**
   * Verify the backend's prerequisites are present (e.g. the docker CLI
   * is reachable). Throws / exits on failure. Runs after config load so
   * the backend can report mode-aware diagnostics in later phases.
   */
  checkPrerequisites(): void;
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
}

/**
 * Resolve the backend for a runtime mode.
 *
 * Phase 1: only Docker is implemented. `host` dispatches to the Docker
 * backend until HostBackend lands in Phase 3; this keeps `--mode host`
 * behaviour identical to Phase 0 (resolved + visible, still docker).
 */
export function resolveBackend(mode: RuntimeMode): RuntimeBackend {
  switch (mode) {
    case "docker":
      return new DockerBackend();
    case "host":
      // Phase 3: return new HostBackend();
      return new DockerBackend();
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