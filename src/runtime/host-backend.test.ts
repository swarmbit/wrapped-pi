// ============================================================
// Tests for HostBackend (Phase 3, slice 1)
// ============================================================
// Covers:
//   - buildNonoRunArgs: profile=wpi, --allow-cwd, --rollback, ports→--listen-port
//   - buildNonoShellArgs: shell variant
//   - dryRun renders the nono command (sandboxed) and bare pi (unsandboxed)
//   - execShell errors (host mode has no container IDs)
//   - host:container port mismatch is reported as an error (via run path)
//   - doctor section set: Runtime, Sandbox, Pi, Platform, Configuration
//
// Spawning nono/pi is not exercised here (no nono binary in CI); only the
// pure argument-assembly and doctor logic, plus the execShell error path.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HostBackend } from "./host-backend";
import type { ResolvedConfig } from "./backend";
import { PI_VERSION, PI_IMAGE } from "../config";

// Mock child_process so commandAvailable / version probes are deterministic and
// never hang on a real pi/nono binary in the test environment.
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));
import { execSync } from "child_process";
const mockedExecSync = vi.mocked(execSync);

function makeHostConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    runtimeMode: "host",
    sandboxBackend: "nono",
    piVersion: PI_VERSION,
    piImage: PI_IMAGE,
    ports: [],
    env: {},
    mounts: [],
    configDir: "/home/user/.pi",
    containerDir: "",
    projectDir: "/home/user/proj",
    workspaceDir: "/home/user/proj",
    debug: false,
    ...overrides,
  } as ResolvedConfig;
}

describe("HostBackend.buildNonoRunArgs", () => {
  let backend: HostBackend;
  beforeEach(() => {
    backend = new HostBackend();
  });

  it("includes --profile wpi --allow-cwd --rollback before -- pi", () => {
    const args = backend.buildNonoRunArgs(makeHostConfig(), ["pi"]);
    expect(args.slice(0, 5)).toEqual(["run", "--profile", "wpi", "--allow-cwd", "--rollback"]);
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("pi");
  });

  it("passes pi args through after --", () => {
    const args = backend.buildNonoRunArgs(makeHostConfig(), ["pi", "-p", "Summarize"]);
    expect(args.slice(-3)).toEqual(["pi", "-p", "Summarize"]);
  });

  it("translates simple ports to --listen-port (host binds directly)", () => {
    const args = backend.buildNonoRunArgs(
      makeHostConfig({ ports: [{ host: 3000, container: 3000 }, { host: 6006, container: 6006 }] }),
      ["pi"]
    );
    const listenIdx = args.reduce<number[]>((acc, a, i) => (a === "--listen-port" ? [...acc, i] : acc), []);
    expect(listenIdx).toHaveLength(2);
    expect(args[listenIdx[0] + 1]).toBe("3000");
    expect(args[listenIdx[1] + 1]).toBe("6006");
  });

  it("does not add --listen-port when no ports configured", () => {
    const args = backend.buildNonoRunArgs(makeHostConfig(), ["pi"]);
    expect(args).not.toContain("--listen-port");
  });
});

describe("HostBackend.buildNonoShellArgs", () => {
  it("uses nono shell with the wpi profile", () => {
    const backend = new HostBackend();
    const args = backend.buildNonoShellArgs(makeHostConfig());
    expect(args[0]).toBe("shell");
    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("wpi");
    expect(args).toContain("--allow-cwd");
    expect(args).toContain("--rollback");
  });
});

describe("HostBackend.dryRun", () => {
  it("renders the nono run command when sandboxed", () => {
    const backend = new HostBackend();
    let out = "";
    const orig = console.log;
    console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
    try {
      backend.dryRun(makeHostConfig(), ["pi", "-p", "hi"]);
    } finally {
      console.log = orig;
    }
    expect(out).toContain("Nono run command:");
    expect(out).toContain("nono run --profile wpi --allow-cwd --rollback -- pi -p hi");
    expect(out).toContain("profile: wpi (extends nolabs-ai/pi");
  });

  it("renders the bare pi command when unsandboxed", () => {
    const backend = new HostBackend();
    let out = "";
    const orig = console.log;
    console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
    try {
      backend.dryRun(makeHostConfig({ sandboxBackend: "none" }), ["pi"]);
    } finally {
      console.log = orig;
    }
    expect(out).toContain("Host run command (unsandboxed):");
    expect(out).toContain("pi");
    expect(out).not.toContain("nono run");
  });
});

describe("HostBackend.execShell", () => {
  it("errors: host mode has no container IDs", async () => {
    const backend = new HostBackend();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(backend.execShell("some-id")).rejects.toThrow(/exit:1/);
    expect(errSpy.mock.calls[0][0]).toMatch(/Docker-mode operation/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("HostBackend.run port validation", () => {
  it("exits on host:container port mismatch (no container to forward to)", async () => {
    const backend = new HostBackend();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const config = makeHostConfig({ ports: [{ host: 8080, container: 3000 }] });
    await expect(backend.run(config, ["pi"])).rejects.toThrow(/exit:1/);
    expect(errSpy.mock.calls[0][0]).toMatch(/host:container port mapping/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("HostBackend.doctor", () => {
  let backend: HostBackend;
  beforeEach(() => {
    vi.clearAllMocks();
    backend = new HostBackend();
    // commandAvailable(bin) returns true iff execSync doesn't throw. Make pi and
    // nono available so prereq/version probes succeed.
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      throw new Error("unexpected execSync: " + cmd);
    });
  });

  it("produces sections Runtime, Sandbox, Pi, Platform, Configuration", async () => {
    const report = await backend.doctor(makeHostConfig());
    expect(report.sections.map((s) => s.name)).toEqual([
      "Runtime",
      "Sandbox",
      "Pi",
      "Platform",
      "Configuration",
    ]);
    expect(report.mode).toBe("host");
  });

  it("Sandbox section reports nono backend (and whether the binary is present)", async () => {
    const backend = new HostBackend();
    const report = await backend.doctor(makeHostConfig({ sandboxBackend: "nono" }));
    const sandbox = report.sections.find((s) => s.name === "Sandbox")!;
    expect(sandbox.checks.find((c) => c.label === "backend")?.detail).toBe("nono");
  });

  it("Sandbox section warns when sandbox=none (unsandboxed opt-out)", async () => {
    const backend = new HostBackend();
    const report = await backend.doctor(makeHostConfig({ sandboxBackend: "none" }));
    const sandbox = report.sections.find((s) => s.name === "Sandbox")!;
    expect(sandbox.checks.find((c) => c.label === "backend")?.detail).toMatch(/none/);
    expect(sandbox.checks.find((c) => c.label === "unsandboxed")?.status).toBe("warn");
  });

  it("Platform section reports the OS platform", async () => {
    const backend = new HostBackend();
    const report = await backend.doctor(makeHostConfig());
    const platform = report.sections.find((s) => s.name === "Platform")!;
    expect(platform.checks.find((c) => c.label === "platform")?.status).toBe("info");
  });
});