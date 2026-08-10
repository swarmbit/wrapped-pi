// ============================================================
// wpi — Doctor report types & shared helpers (Phase 2)
// ============================================================
// Mode-aware doctor (Docker only in Phase 2). Backends produce a
// DoctorReport; cli.ts renders it and exits with the report's
// exit code.
//
// Exit codes:
//   0  healthy  — all checks passed
//   1  warn     — non-blocking issues (e.g. secret-looking env,
//                 image not built, unsandboxed)
//   2  error    — blocking prerequisites missing (e.g. Docker CLI
//                 or daemon unavailable)
//
// Per docs/dual-mode-implementation-plan.md Phase 2:
//   - Sections: Runtime, Sandbox, Pi, Docker, Configuration.
//   - Sandbox reports "not configured" gracefully until Phase 3.
//   - Secret-looking YAML env values warn.
// ============================================================

import type { RuntimeMode, SandboxBackend } from "../config";
import type { ResolvedConfig } from "./backend";

export type DoctorStatus = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
  status: DoctorStatus;
  /** Short label, e.g. "docker daemon" or "pi version". */
  label: string;
  /** Human-readable detail, e.g. "Docker version 29.7.2" or "not running". */
  detail: string;
}

export interface DoctorSection {
  name: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  mode: RuntimeMode;
  sections: DoctorSection[];
  /** Computed exit code: 0 healthy, 1 warn, 2 error. */
  exitCode: 0 | 1 | 2;
}

// ── Exit-code computation ─────────────────────────────────────

export function computeExitCode(sections: DoctorSection[]): 0 | 1 | 2 {
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === "error") return 2;
    }
  }
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === "warn") return 1;
    }
  }
  return 0;
}

export function buildReport(mode: RuntimeMode, sections: DoctorSection[]): DoctorReport {
  return { mode, sections, exitCode: computeExitCode(sections) };
}

// ── Secret detection ─────────────────────────────────────────
//
// Warn on env var *names* that look like secrets so users move them
// to nono credential routes (Phase 3+). Matching on the name (not the
// value) keeps the check deterministic and avoids logging secrets.

const SECRET_KEY_RE = /(secret|token|password|passwd|credential|private|api[_-]?key|_key$)/i;

/**
 * Return true if an environment variable name looks like it holds a secret.
 * Conservative: prefers false negatives over noisy false positives, but is
 * deliberately broad for `_KEY` / `API_KEY` / `TOKEN` / `SECRET` style names.
 */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** env keys (from resolved config) that look like secrets, in stable order. */
export function findSecretEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter(looksLikeSecretKey).sort();
}

// ── Shared section builders ──────────────────────────────────
//
// Runtime and Configuration sections are mode-agnostic; Docker- and
// host-specific sections are built by the respective backends.

export function buildRuntimeSection(mode: RuntimeMode): DoctorSection {
  return {
    name: "Runtime",
    checks: [
      { status: "ok", label: "mode", detail: mode },
    ],
  };
}

/**
 * Build the Sandbox section for docker mode. In Phase 3 docker defaults to
 * `none`; docker+nono lands in Phase 4, so an explicit nono is reported as
 * info "not yet dispatched" rather than erroring in the report (the config
 * loader already rejects docker+nono). host mode builds its own richer
 * Sandbox section with a nono-binary check.
 */
export function buildDockerSandboxSection(sandbox: SandboxBackend): DoctorSection {
  if (sandbox === "none") {
    return {
      name: "Sandbox",
      checks: [
        { status: "ok", label: "backend", detail: "none (docker default in Phase 3)" },
        { status: "info", label: "docker+nono", detail: "lands in Phase 4" },
      ],
    };
  }
  return {
    name: "Sandbox",
    checks: [
      { status: "info", label: "backend", detail: "nono (docker+nono dispatch lands in Phase 4)" },
    ],
  };
}

export function buildConfigurationSection(config: ResolvedConfig): DoctorSection {
  const checks: DoctorCheck[] = [];

  const userConfigPath = config.configDir + "/wpi.yml";
  const userFound = safeExists(userConfigPath);
  checks.push({
    status: "info",
    label: "user config",
    detail: `${userConfigPath} (${userFound ? "found" : "not found"})`,
  });

  const projectConfigPath = config.containerDir
    ? config.containerDir + "/wpi.yml"
    : "";
  const projectFound = projectConfigPath ? safeExists(projectConfigPath) : false;
  checks.push({
    status: "info",
    label: "project config",
    detail: projectConfigPath
      ? `${projectConfigPath} (${projectFound ? "found" : "not found"})`
      : "(no .pi dir)",
  });

  // Secret-looking env warning: push people toward credential routes.
  const secretKeys = findSecretEnvKeys(config.env);
  if (secretKeys.length > 0) {
    for (const key of secretKeys) {
      checks.push({
        status: "warn",
        label: `env ${key}`,
        detail:
          "looks like a secret in env — prefer nono credential routes (Phase 3+)",
      });
    }
  } else if (Object.keys(config.env).length > 0) {
    checks.push({
      status: "ok",
      label: "env",
      detail: `${Object.keys(config.env).length} var(s), none look like secrets`,
    });
  } else {
    checks.push({ status: "ok", label: "env", detail: "(none)" });
  }

  // Docker-only config sanity (relevant in both modes for diagnostics).
  if (config.runtimeMode === "host" && config.dockerfileExtension) {
    checks.push({
      status: "warn",
      label: "docker.extension",
      detail: "ignored in host mode (no image build)",
    });
  }

  return { name: "Configuration", checks };
}

// ── Rendering ───────────────────────────────────────────────

const ICON: Record<DoctorStatus, string> = {
  ok: "✓",
  warn: "⚠",
  error: "✗",
  info: "•",
};

function safeExists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Render a DoctorReport as a human-readable string (no trailing newline). */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`wpi doctor — runtime mode: ${report.mode}`);
  lines.push("");
  for (const section of report.sections) {
    lines.push(section.name);
    for (const check of section.checks) {
      lines.push(`  ${ICON[check.status]} ${check.label}: ${check.detail}`);
    }
    lines.push("");
  }
  // Summary
  const errors = countStatus(report, "error");
  const warns = countStatus(report, "warn");
  const summary =
    errors > 0
      ? `${errors} error(s), ${warns} warning(s)`
      : warns > 0
      ? `${warns} warning(s)`
      : "healthy";
  lines.push(`Summary: ${summary} (exit ${report.exitCode})`);
  return lines.join("\n");
}

function countStatus(report: DoctorReport, status: DoctorStatus): number {
  let n = 0;
  for (const section of report.sections) {
    for (const check of section.checks) {
      if (check.status === status) n++;
    }
  }
  return n;
}