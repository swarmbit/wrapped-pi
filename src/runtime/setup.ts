// ============================================================
// wpi — setup report types & rendering (Phase 6)
// ============================================================
// `wpi setup [--mode host] [--sandbox nono]` provisions artifacts and
// verifies a (mode, sandbox) combination is ready to run, step by step:
//
//   docker+none  docker cli + daemon
//   docker+nono  + nono binary, wpi-docker profile, mount/socket grants,
//                 smoke test (nono run --profile wpi-docker -- docker --version)
//   host+none    platform, pi binary, unsandboxed warning
//   host+nono    + nono binary, nono pack (nolabs-ai/pi), wpi profile,
//                 package wiring, network config, smoke test
//                 (nono run --profile wpi -- pi --version)
//
// Unlike doctor (read-only), setup WRITES the artifacts it provisions
// (profiles, package copy + settings wiring) — the same writes a first
// build/run would do — so it is a no-op for already-configured machines.
// Exit codes: 0 ready, 1 warn (non-blocking), 2 error (blocking).
// ============================================================

import type { RuntimeMode } from "../config";
import { spawnSync } from "child_process";

export type SetupStatus = "ok" | "warn" | "error" | "info";

export interface SetupStep {
  /** Short label, e.g. "docker daemon" or "wpi profile". */
  label: string;
  status: SetupStatus;
  /** Human-readable detail. */
  detail: string;
}

export interface SetupReport {
  mode: RuntimeMode;
  steps: SetupStep[];
  /** Computed exit code: 0 ready, 1 warn, 2 error. */
  exitCode: 0 | 1 | 2;
}

/** Error dominates warn; info/ok never raise the exit code. */
export function computeSetupExitCode(steps: SetupStep[]): 0 | 1 | 2 {
  if (steps.some((s) => s.status === "error")) return 2;
  if (steps.some((s) => s.status === "warn")) return 1;
  return 0;
}

export function buildSetupReport(mode: RuntimeMode, steps: SetupStep[]): SetupReport {
  return { mode, steps, exitCode: computeSetupExitCode(steps) };
}

const ICON: Record<SetupStatus, string> = {
  ok: "✓",
  warn: "⚠",
  error: "✗",
  info: "•",
};

/** Render a SetupReport as a human-readable string (no trailing newline). */
export function renderSetupReport(report: SetupReport): string {
  const lines: string[] = [];
  lines.push(`wpi setup — runtime mode: ${report.mode}`);
  lines.push("");
  for (const step of report.steps) {
    lines.push(`  ${ICON[step.status]} ${step.label}: ${step.detail}`);
  }
  lines.push("");
  const errors = report.steps.filter((s) => s.status === "error").length;
  const warns = report.steps.filter((s) => s.status === "warn").length;
  const summary = errors > 0 ? `${errors} error(s), ${warns} warning(s)` : warns > 0 ? `${warns} warning(s)` : "ready";
  lines.push(`Summary: ${summary} (exit ${report.exitCode})`);
  return lines.join("\n");
}

export interface SmokeResult {
  ok: boolean;
  /** Combined stdout+stderr (trimmed) — diagnostics on failure, version on success. */
  output: string;
}

/**
 * Run a smoke-test command synchronously and capture its output.
 * Used to verify the full stack end-to-end (e.g. nono supervising pi).
 */
export function runSmoke(bin: string, args: string[], timeoutMs = 30_000): SmokeResult {
  try {
    const res = spawnSync(bin, args, { stdio: "pipe", timeout: timeoutMs });
    const output = `${res.stdout?.toString() ?? ""}${res.stderr?.toString() ?? ""}`.trim();
    if (res.status === 0) return { ok: true, output };
    return { ok: false, output: output || `exited with status ${res.status}` };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * First meaningful line of a smoke output: skips nono banner/log noise
 * (timestamps, WARN/ERROR markers, ANSI codes) to surface the real signal
 * (e.g. the version pi printed).
 */
export function firstLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim());
  const signal = lines.find(
    (l) => l.length > 0 && !/(WARN|ERROR|warn|error|\u001b\[)/.test(l)
  );
  return signal ?? lines.find((l) => l.length > 0) ?? "";
}
