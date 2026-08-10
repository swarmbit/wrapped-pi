// ============================================================
// Tests for runtime doctor — Phase 2
// ============================================================
// Covers:
//   - secret-key detection (looksLikeSecretKey / findSecretEnvKeys)
//   - exit-code computation (0 healthy / 1 warn / 2 error)
//   - error dominates warn; info/ok never affect the exit code
//   - shared sections: Runtime reports sandbox "not configured" (info)
//   - Configuration warns on secret-looking env keys
//   - renderDoctorReport formats sections, statuses, and summary
//
// DockerBackend.doctor's Docker CLI/daemon checks shell out to `docker`
// and are environment-dependent; they are exercised here via mocked
// child_process so the report shape is deterministic.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  looksLikeSecretKey,
  findSecretEnvKeys,
  computeExitCode,
  buildReport,
  buildRuntimeSection,
  buildDockerSandboxSection,
  buildConfigurationSection,
  renderDoctorReport,
} from "./doctor";
import { DockerBackend } from "./docker-backend";
import type { ResolvedConfig } from "./backend";
import { PI_VERSION, PI_IMAGE, EMPTY_NETWORK, EMPTY_NONO } from "../config";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    runtimeMode: "docker",
    sandboxBackend: "none",
    network: EMPTY_NETWORK,
    workspace: EMPTY_NONO,
    nono: EMPTY_NONO,
    piVersion: PI_VERSION,
    piImage: PI_IMAGE,
    ports: [],
    env: {},
    mounts: [],
    configDir: "/home/user/.pi",
    containerDir: "/home/user/proj/.pi",
    projectDir: "/home/user/proj",
    workspaceDir: "/home/user/proj",
    debug: false,
    ...overrides,
  } as ResolvedConfig;
}

// ── Secret detection ─────────────────────────────────────────

describe("looksLikeSecretKey", () => {
  it("flags common secret-bearing names", () => {
    expect(looksLikeSecretKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(looksLikeSecretKey("FIRECRAWL_API_KEY")).toBe(true);
    expect(looksLikeSecretKey("GITHUB_TOKEN")).toBe(true);
    expect(looksLikeSecretKey("DATABASE_PASSWORD")).toBe(true);
    expect(looksLikeSecretKey("MY_SECRET")).toBe(true);
    expect(looksLikeSecretKey("CREDENTIAL")).toBe(true);
    expect(looksLikeSecretKey("PRIVATE_KEY")).toBe(true);
  });

  it("does not flag ordinary config names", () => {
    expect(looksLikeSecretKey("FIRECRAWL_BASE_URL")).toBe(false);
    expect(looksLikeSecretKey("FIRECRAWL_CACHE_TTL")).toBe(false);
    expect(looksLikeSecretKey("PORT")).toBe(false);
    expect(looksLikeSecretKey("OLLAMA_HOST")).toBe(false);
    expect(looksLikeSecretKey("NODE_ENV")).toBe(false);
    expect(looksLikeSecretKey("WORKSPACE_DIR")).toBe(false);
  });
});

describe("findSecretEnvKeys", () => {
  it("returns secret-looking keys in stable sorted order", () => {
    const env = {
      OLLAMA_HOST: "http://x",
      GITHUB_TOKEN: "ghp_x",
      ANTHROPIC_API_KEY: "sk-x",
      FIRECRAWL_BASE_URL: "http://y",
    };
    expect(findSecretEnvKeys(env)).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
  });

  it("returns an empty array when nothing looks like a secret", () => {
    expect(findSecretEnvKeys({ FOO: "bar", PORT: "3000" })).toEqual([]);
  });

  it("returns an empty array for an empty env", () => {
    expect(findSecretEnvKeys({})).toEqual([]);
  });
});

// ── Exit-code computation ────────────────────────────────────

describe("computeExitCode", () => {
  it("is 0 when all checks are ok/info", () => {
    expect(
      computeExitCode([
        { name: "Runtime", checks: [{ status: "ok", label: "a", detail: "x" }, { status: "info", label: "b", detail: "y" }] },
      ])
    ).toBe(0);
  });

  it("is 1 when only warnings are present", () => {
    expect(
      computeExitCode([
        { name: "Runtime", checks: [{ status: "ok", label: "a", detail: "x" }, { status: "warn", label: "b", detail: "y" }] },
      ])
    ).toBe(1);
  });

  it("is 2 when any error is present", () => {
    expect(
      computeExitCode([
        { name: "Runtime", checks: [{ status: "ok", label: "a", detail: "x" }] },
        { name: "Docker", checks: [{ status: "error", label: "daemon", detail: "down" }] },
      ])
    ).toBe(2);
  });

  it("error dominates warn (2, not 1)", () => {
    expect(
      computeExitCode([
        { name: "Runtime", checks: [{ status: "warn", label: "a", detail: "x" }] },
        { name: "Docker", checks: [{ status: "error", label: "cli", detail: "missing" }] },
      ])
    ).toBe(2);
  });

  it("info never raises the exit code", () => {
    expect(
      computeExitCode([
        { name: "Runtime", checks: [{ status: "info", label: "sandbox", detail: "n/a" }] },
      ])
    ).toBe(0);
  });
});

// ── Shared sections ──────────────────────────────────────────

describe("buildRuntimeSection", () => {
  it("reports mode ok (sandbox is its own section in Phase 3)", () => {
    const section = buildRuntimeSection("docker");
    expect(section.name).toBe("Runtime");
    expect(section.checks).toEqual([{ status: "ok", label: "mode", detail: "docker" }]);
  });

  it("works for host mode", () => {
    const section = buildRuntimeSection("host");
    expect(section.checks[0]).toEqual({ status: "ok", label: "mode", detail: "host" });
  });
});

describe("buildDockerSandboxSection", () => {
  it("reports none (docker default) with Phase 4 note for docker+none", () => {
    const section = buildDockerSandboxSection("none");
    expect(section.name).toBe("Sandbox");
    expect(section.checks.find((c) => c.label === "backend")?.status).toBe("ok");
    expect(section.checks.find((c) => c.label === "docker+nono")?.detail).toMatch(/Phase 4/);
  });

  it("reports nono as info (not dispatched) for docker+nono", () => {
    const section = buildDockerSandboxSection("nono");
    expect(section.checks.find((c) => c.label === "backend")?.status).toBe("info");
  });
});

describe("buildConfigurationSection", () => {
  it("warns once per secret-looking env key", () => {
    const config = makeConfig({
      env: {
        ANTHROPIC_API_KEY: "sk-test",
        GITHUB_TOKEN: "ghp_test",
        FOO: "bar",
      },
    });
    const section = buildConfigurationSection(config);
    expect(section.name).toBe("Configuration");
    const warnings = section.checks.filter((c) => c.status === "warn");
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.label).sort()).toEqual(["env ANTHROPIC_API_KEY", "env GITHUB_TOKEN"]);
    for (const w of warnings) {
      expect(w.detail).toMatch(/credential routes/);
    }
  });

  it("reports env ok when no secret-looking keys", () => {
    const config = makeConfig({ env: { OLLAMA_HOST: "http://x", PORT: "3000" } });
    const section = buildConfigurationSection(config);
    const envCheck = section.checks.find((c) => c.label === "env");
    expect(envCheck?.status).toBe("ok");
  });

  it("reports env (none) when empty", () => {
    const config = makeConfig({ env: {} });
    const section = buildConfigurationSection(config);
    const envCheck = section.checks.find((c) => c.label === "env");
    expect(envCheck?.status).toBe("ok");
    expect(envCheck?.detail).toBe("(none)");
  });

  it("warns about docker.extension ignored in host mode", () => {
    const config = makeConfig({ runtimeMode: "host", dockerfileExtension: "RUN apt-get install -y python3" });
    const section = buildConfigurationSection(config);
    const ext = section.checks.find((c) => c.label === "docker.extension");
    expect(ext?.status).toBe("warn");
    expect(ext?.detail).toMatch(/ignored in host mode/);
  });
});

// ── Rendering ───────────────────────────────────────────────

describe("renderDoctorReport", () => {
  it("renders section headers, status icons, and summary", () => {
    const report = buildReport("docker", [
      buildRuntimeSection("docker"),
      buildDockerSandboxSection("none"),
      {
        name: "Docker",
        checks: [
          { status: "ok", label: "docker cli", detail: "Docker version 29.7.2" },
          { status: "error", label: "docker daemon", detail: "not running" },
        ],
      },
    ]);
    const out = renderDoctorReport(report);
    expect(out).toContain("wpi doctor — runtime mode: docker");
    expect(out).toContain("Runtime");
    expect(out).toContain("✓ mode: docker");
    expect(out).toContain("Sandbox");
    expect(out).toContain("Docker");
    expect(out).toContain("✗ docker daemon: not running");
    expect(out).toContain("Summary: 1 error(s), 0 warning(s) (exit 2)");
  });

  it("summary reports healthy when exit 0", () => {
    const report = buildReport("docker", [buildRuntimeSection("docker")]);
    expect(renderDoctorReport(report)).toContain("Summary: healthy (exit 0)");
  });
});

// ── DockerBackend.doctor (mocked child_process / docker) ──────

// Mock child_process so the Docker CLI/daemon checks are deterministic.
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawnSync } from "child_process";

import type { SpawnSyncReturns } from "child_process";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);

/** Build a fully-typed SpawnSyncReturns so mocks satisfy tsc strict mode. */
function spawnResult(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return { status, stdout, stderr, pid: 0, output: [stdout, stderr], signal: null };
}

describe("DockerBackend.doctor", () => {
  let backend: DockerBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new DockerBackend();
  });

  it("reports healthy (exit 0) when docker cli + daemon are up and image is built", async () => {
    // checkPrerequisites isn't called here; doctor shells out itself.
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2, build abc";
      throw new Error("unexpected execSync call: " + cmd);
    });
    mockedSpawnSync.mockReturnValue(spawnResult(0, "29.7.2"));

    const report = await backend.doctor(makeConfig());
    expect(report.exitCode).toBe(0);
    const dockerSection = report.sections.find((s) => s.name === "Docker")!;
    expect(dockerSection.checks.find((c) => c.label === "docker cli")?.status).toBe("ok");
    expect(dockerSection.checks.find((c) => c.label === "docker daemon")?.status).toBe("ok");
    const piSection = report.sections.find((s) => s.name === "Pi")!;
    // imageExists is mocked via spawnSync returning status 0 => treated as built.
    expect(piSection.checks.find((c) => c.label === "image")?.detail).toContain("built");
  });

  it("reports error (exit 2) when docker cli is missing", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mockedSpawnSync.mockReturnValue(spawnResult(1, "", "not found"));

    const report = await backend.doctor(makeConfig());
    expect(report.exitCode).toBe(2);
    const dockerSection = report.sections.find((s) => s.name === "Docker")!;
    expect(dockerSection.checks.find((c) => c.label === "docker cli")?.status).toBe("error");
    expect(dockerSection.checks.find((c) => c.label === "docker daemon")?.detail).toMatch(/docker cli missing/);
  });

  it("reports error (exit 2) when daemon is down (spawnSync non-zero)", async () => {
    mockedExecSync.mockReturnValue("Docker version 29.7.2");
    mockedSpawnSync.mockReturnValue(spawnResult(1, "", "Cannot connect to the Docker daemon"));

    const report = await backend.doctor(makeConfig());
    expect(report.exitCode).toBe(2);
    const dockerSection = report.sections.find((s) => s.name === "Docker")!;
    expect(dockerSection.checks.find((c) => c.label === "docker daemon")?.status).toBe("error");
  });

  it("includes a Configuration warning for secret-looking env", async () => {
    mockedExecSync.mockReturnValue("Docker version 29.7.2");
    mockedSpawnSync.mockReturnValue(spawnResult(0, "29.7.2"));

    const report = await backend.doctor(
      makeConfig({ env: { ANTHROPIC_API_KEY: "sk-test", FIRECRAWL_BASE_URL: "http://x" } })
    );
    const cfgSection = report.sections.find((s) => s.name === "Configuration")!;
    const warns = cfgSection.checks.filter((c) => c.status === "warn");
    expect(warns.map((w) => w.label)).toEqual(["env ANTHROPIC_API_KEY"]);
  });

  it("warns (exit 1) when image is not built but docker is healthy", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2";
      throw new Error("unexpected: " + cmd);
    });
    // docker info succeeds (daemon up), but docker image inspect fails (status 1).
    mockedSpawnSync.mockImplementation((bin, args) => {
      if (args?.[0] === "info") return spawnResult(0, "29.7.2");
      if (args?.[0] === "image" && args[1] === "inspect")
        return spawnResult(1, "", "no such image");
      return spawnResult(1);
    });

    const report = await backend.doctor(makeConfig());
    expect(report.exitCode).toBe(1);
    const piSection = report.sections.find((s) => s.name === "Pi")!;
    expect(piSection.checks.find((c) => c.label === "image")?.status).toBe("warn");
  });

  it("section order is Runtime, Sandbox, Pi, Docker, Configuration", async () => {
    mockedExecSync.mockReturnValue("Docker version 29.7.2");
    mockedSpawnSync.mockReturnValue(spawnResult(0, "29.7.2"));

    const report = await backend.doctor(makeConfig());
    expect(report.sections.map((s) => s.name)).toEqual([
      "Runtime",
      "Sandbox",
      "Pi",
      "Docker",
      "Configuration",
    ]);
  });
});