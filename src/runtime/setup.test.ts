// ============================================================
// Tests for wpi setup (Phase 6) — both backends, both sandbox states
// ============================================================
// Covers:
//   - report types, exit codes, rendering
//   - DockerBackend.setup: docker+none, docker+nono (profile provision,
//     grant validation, smoke test), missing docker/nono
//   - HostBackend.setup: host+none, host+nono (platform, pi, nono, pack,
//     profile, package wiring, network, smoke test), missing pi,
//     network-blocked warning, pack pull when missing
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DockerBackend } from "./docker-backend";
import { HostBackend } from "./host-backend";
import type { ResolvedConfig } from "./backend";
import { PI_VERSION, PI_IMAGE, EMPTY_NETWORK, DEFAULT_DOCKER_SOCKET, DEFAULT_NONO_DOCKER_PROFILE } from "../config";
import {
  computeSetupExitCode,
  buildSetupReport,
  renderSetupReport,
  runSmoke,
  firstLine,
  type SetupStep,
} from "./setup";

// Mock child_process so CLI/daemon/version probes and smoke tests are deterministic.
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));
import { execSync, spawnSync } from "child_process";
import type { SpawnSyncReturns } from "child_process";
const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);

function spawnResult(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return { status, stdout, stderr, pid: 0, output: [stdout, stderr], signal: null };
}

function baseConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    runtimeMode: "docker",
    sandboxBackend: "nono",
    network: EMPTY_NETWORK,
    workspace: { allowPaths: [], readPaths: [] },
    nono: { allowPaths: [], readPaths: [], dockerProfile: DEFAULT_NONO_DOCKER_PROFILE },
    dockerSocket: DEFAULT_DOCKER_SOCKET,
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

let tmpHome: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-setup-home-")));
  vi.stubEnv("HOME", tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ── Report primitives ────────────────────────────────────────

describe("setup report primitives", () => {
  it("computes exit codes: error dominates warn, info/ok stay 0", () => {
    expect(computeSetupExitCode([{ status: "ok", label: "a", detail: "x" }])).toBe(0);
    expect(computeSetupExitCode([{ status: "warn", label: "a", detail: "x" }])).toBe(1);
    expect(computeSetupExitCode([{ status: "error", label: "a", detail: "x" }])).toBe(2);
    expect(computeSetupExitCode([{ status: "warn", label: "a", detail: "x" }, { status: "error", label: "b", detail: "y" }])).toBe(2);
  });

  it("renders steps with icons and a summary", () => {
    const report = buildSetupReport("host", [
      { status: "ok", label: "pi binary", detail: "pi 0.84.1" },
      { status: "warn", label: "unsandboxed", detail: "opt-out" },
    ]);
    const out = renderSetupReport(report);
    expect(out).toContain("wpi setup — runtime mode: host");
    expect(out).toContain("✓ pi binary: pi 0.84.1");
    expect(out).toContain("⚠ unsandboxed: opt-out");
    expect(out).toContain("Summary: 1 warning(s) (exit 1)");
  });

  it("runSmoke captures output and failure text", () => {
    mockedSpawnSync.mockReturnValue(spawnResult(0, "Docker version 29.7.2\n") as never);
    expect(runSmoke("docker", ["--version"])).toEqual({ ok: true, output: "Docker version 29.7.2" });
    mockedSpawnSync.mockReturnValue(spawnResult(1, "", "boom") as never);
    expect(runSmoke("nono", ["x"]).ok).toBe(false);
    expect(firstLine("a\n\nb\n")).toBe("a");
  });
});

// ── DockerBackend.setup ──────────────────────────────────────

describe("DockerBackend.setup", () => {
  let backend: DockerBackend;
  beforeEach(() => {
    backend = new DockerBackend();
  });

  it("docker+none: cli+daemon ok, unsandboxed warning (exit 1)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2, build abc";
      throw new Error("unexpected execSync: " + cmd);
    });
    mockedSpawnSync.mockReturnValue(spawnResult(0, "29.7.2") as never);

    const report = await backend.setup(baseConfig({ sandboxBackend: "none" }));
    expect(report.exitCode).toBe(1);
    expect(report.steps.map((s) => s.label)).toEqual(["docker cli", "docker daemon", "unsandboxed"]);
    expect(report.steps.find((s) => s.label === "docker daemon")?.detail).toContain("running");
  });

  it("docker+none: missing docker cli is an error (exit 2)", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const report = await backend.setup(baseConfig({ sandboxBackend: "none" }));
    expect(report.exitCode).toBe(2);
    expect(report.steps.find((s) => s.label === "docker cli")?.status).toBe("error");
    expect(report.steps.find((s) => s.label === "docker daemon")?.detail).toMatch(/docker cli missing/);
  });

  it("docker+nono: provisions profile, validates grants, smoke test passes (exit 0)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2, build abc";
      if (cmd === "nono --version") return "nono 0.73.0";
      throw new Error("unexpected execSync: " + cmd);
    });
    mockedSpawnSync.mockImplementation((bin, args) => {
      if (bin === "docker" && args?.[0] === "info") return spawnResult(0, "29.7.2");
      if (bin === "nono") return spawnResult(0, "Docker version 29.7.2"); // smoke test
      return spawnResult(1);
    });

    const report = await backend.setup(baseConfig());
    expect(report.exitCode).toBe(0);
    const labels = report.steps.map((s) => s.label);
    expect(labels).toEqual(["docker cli", "docker daemon", "nono binary", "wpi-docker profile", "profile grants", "smoke test"]);
    // The profile was actually written (setup is not read-only).
    expect(fs.existsSync(path.join(tmpHome, ".config", "nono", "profiles", "wpi-docker.json"))).toBe(true);
    expect(report.steps.find((s) => s.label === "profile grants")?.detail).toContain("all granted");
    expect(report.steps.find((s) => s.label === "smoke test")?.detail).toContain("Docker version");
  });

  it("docker+nono: missing nono is an error with install hint (exit 2)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2";
      throw new Error("not installed"); // nono --version throws
    });
    mockedSpawnSync.mockReturnValue(spawnResult(0, "29.7.2") as never);

    const report = await backend.setup(baseConfig());
    expect(report.exitCode).toBe(2);
    expect(report.steps.find((s) => s.label === "nono binary")?.detail).toMatch(/nono\.sh\/install\.sh/);
    expect(report.steps.find((s) => s.label === "smoke test")).toBeUndefined();
  });
});

// ── HostBackend.setup ────────────────────────────────────────

describe("HostBackend.setup", () => {
  let backend: HostBackend;
  let tmpSource: string;

  beforeEach(() => {
    tmpSource = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-setup-src-")));
    fs.mkdirSync(path.join(tmpSource, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(tmpSource, "package.json"), JSON.stringify({ name: "wpi-defaults" }));
    fs.writeFileSync(path.join(tmpSource, "extensions/sample.ts"), "export const x = 1;\n");
    backend = new HostBackend({ packageSourceDir: tmpSource });
  });

  afterEach(() => {
    fs.rmSync(tmpSource, { recursive: true, force: true });
  });

  function hostConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return baseConfig({ runtimeMode: "host", configDir: path.join(tmpHome, ".pi"), ...overrides });
  }

  function mockHealthyHost(): void {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      if (cmd === "nono list --installed") return "nolabs-ai/pi\t0.2.0\n";
      throw new Error("unexpected execSync: " + cmd);
    });
    mockedSpawnSync.mockImplementation((bin, args) => {
      if (bin === "nono" && args?.[0] === "run") return spawnResult(0, "pi 0.84.1"); // smoke test
      return spawnResult(1);
    });
  }

  it("host+none: platform+pi ok, unsandboxed warning (exit 1)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      throw new Error("unexpected: " + cmd);
    });
    const report = await backend.setup(hostConfig({ sandboxBackend: "none" }));
    expect(report.exitCode).toBe(1);
    expect(report.steps.map((s) => s.label)).toEqual(["platform", "pi binary", "unsandboxed"]);
  });

  it("host+none: missing pi is an error with install hint (exit 2)", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const report = await backend.setup(hostConfig({ sandboxBackend: "none" }));
    expect(report.exitCode).toBe(2);
    expect(report.steps.find((s) => s.label === "pi binary")?.detail).toMatch(/npm install -g/);
  });

  it("host+nono: full stack verified end-to-end (exit 0)", async () => {
    mockHealthyHost();
    const report = await backend.setup(
      hostConfig({ network: { ...EMPTY_NETWORK, allowDomains: ["api.anthropic.com"] } })
    );
    expect(report.exitCode).toBe(0);
    expect(report.steps.map((s) => s.label)).toEqual([
      "platform",
      "pi binary",
      "nono binary",
      "nono pack",
      "wpi profile",
      "package wiring",
      "network",
      "smoke test",
    ]);
    // Artifacts actually provisioned (setup is not read-only).
    expect(fs.existsSync(path.join(tmpHome, ".config", "nono", "profiles", "wpi.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".pi", "wpi-package", "1.0.0", "extensions/sample.ts"))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpHome, ".pi", "agent", "settings.json"), "utf-8"));
    expect(settings.packages).toContain(path.join(tmpHome, ".pi", "wpi-package", "1.0.0"));
    expect(report.steps.find((s) => s.label === "smoke test")?.detail).toContain("pi 0.84.1");
  });

  it("host+nono: pulls the pack when nolabs-ai/pi is not installed", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      throw new Error("not installed"); // nono list --installed fails
    });
    mockedSpawnSync.mockImplementation((bin, args) => {
      if (bin === "nono" && args?.[0] === "pull") return spawnResult(0, "pulled nolabs-ai/pi");
      if (bin === "nono" && args?.[0] === "run") return spawnResult(0, "pi 0.84.1");
      return spawnResult(1);
    });

    const report = await backend.setup(
      hostConfig({ network: { ...EMPTY_NETWORK, allowDomains: ["api.anthropic.com"] } })
    );
    expect(report.exitCode).toBe(0);
    expect(mockedSpawnSync).toHaveBeenCalledWith("nono", ["pull", "nolabs-ai/pi"], expect.anything());
    expect(report.steps.find((s) => s.label === "nono pack")?.detail).toContain("pulled");
  });

  it("host+nono: warns when filtered network allows nothing (exit 1)", async () => {
    mockHealthyHost();
    const report = await backend.setup(hostConfig({ network: { ...EMPTY_NETWORK, mode: "filtered", allowDomains: [], credentials: [] } }));
    expect(report.exitCode).toBe(1);
    const net = report.steps.find((s) => s.label === "network")!;
    expect(net.status).toBe("warn");
    expect(net.detail).toMatch(/will be blocked/);
  });

  it("host+nono: pack missing + pull failing is an error (exit 2)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      throw new Error("not installed");
    });
    mockedSpawnSync.mockReturnValue(spawnResult(1, "", "registry unreachable") as never);
    const report = await backend.setup(hostConfig());
    expect(report.exitCode).toBe(2);
    expect(report.steps.find((s) => s.label === "nono pack")?.status).toBe("error");
  });
});
