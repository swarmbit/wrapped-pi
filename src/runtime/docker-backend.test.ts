// ============================================================
// Tests for DockerBackend — in-container nono (Phase 4 v2)
// ============================================================
// Covers:
//   - docker+nono: the docker client is NEVER wrapped; wpi ensures the
//     shared wpi nono profile on the host (mounted into the container)
//     and the entrypoint wraps pi inside the container.
//   - sandbox: none prints the unsandboxed opt-out notice, no profile.
//   - profile drift is warned (never overwritten).
//   - dry-run renders plain docker commands with a sandbox note.
//   - setup/doctor report the in-container sandbox state.
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DockerBackend } from "./docker-backend";
import type { ResolvedConfig } from "./backend";
import { PI_VERSION, PI_IMAGE, EMPTY_NETWORK } from "../config";

// Keep the real docker.ts (imageExists/spawn wiring) but stub the heavy
// dispatch entry points so build/run never touch a real docker daemon.
vi.mock("../docker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../docker")>();
  return {
    ...actual,
    buildImage: vi.fn(),
    runContainer: vi.fn().mockResolvedValue(undefined),
    shellInContainer: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawnSync } from "child_process";
import { buildImage, imageExists } from "../docker";
import { wpiProfilePath } from "./profile";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedBuildImage = vi.mocked(buildImage);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    runtimeMode: "docker",
    sandboxBackend: "nono",
    network: EMPTY_NETWORK,
    workspace: { allowPaths: [], readPaths: [] },
    nono: { allowPaths: [], readPaths: [] },
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
  };
}

let tmpHome: string;
let backend: DockerBackend;

beforeEach(() => {
  vi.clearAllMocks();
  backend = new DockerBackend();
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-docker-backend-")));
  vi.stubEnv("HOME", tmpHome);
  // docker probes succeed by default; spawnSync returns a successful (status 0)
  // result so imageExists treats images as present.
  mockedExecSync.mockReturnValue("ok" as never);
  mockedSpawnSync.mockReturnValue({
    status: 0,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    pid: 0,
    output: [],
    signal: null,
    error: undefined,
  } as never);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("DockerBackend — in-container nono", () => {
  it("build() ensures the shared wpi profile and never wraps the docker client", () => {
    backend.build(makeConfig());
    expect(mockedBuildImage).toHaveBeenCalledTimes(1);
    // The wpi profile was written for the mounted ~/.config/nono.
    expect(fs.existsSync(wpiProfilePath(tmpHome))).toBe(true);
    // docker calls in docker.ts run plain (no nono prefix).
    imageExists("pi-agent:test");
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", "pi-agent:test"],
      expect.anything()
    );
  });

  it("is idempotent: an in-sync profile is kept as-is", () => {
    backend.build(makeConfig());
    const p = wpiProfilePath(tmpHome);
    const before = fs.readFileSync(p, "utf-8");
    backend.build(makeConfig());
    expect(fs.readFileSync(p, "utf-8")).toBe(before);
  });

  it("warns on profile drift without overwriting (shared with host mode)", () => {
    backend.build(makeConfig());
    const p = wpiProfilePath(tmpHome);
    const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
    onDisk.meta.version = "0.0.0";
    fs.writeFileSync(p, JSON.stringify(onDisk));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    backend.build(makeConfig());
    const errOutput = errSpy.mock.calls.flat().join(" ");
    errSpy.mockRestore();

    expect(errOutput).toContain("profile drift");
    expect(JSON.parse(fs.readFileSync(p, "utf-8")).meta.version).toBe("0.0.0"); // never overwritten
    expect(mockedBuildImage).toHaveBeenCalledTimes(2); // still builds
  });

  it("sandbox: none prints the UNSANDBOXED opt-out notice and writes no profile", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    backend.build(makeConfig({ sandboxBackend: "none" }));
    const errOutput = errSpy.mock.calls.flat().join(" ");
    errSpy.mockRestore();

    expect(errOutput).toContain("UNSANDBOXED");
    expect(fs.existsSync(wpiProfilePath(tmpHome))).toBe(false);
  });

  it("run() and shell() also ensure the profile", async () => {
    await backend.run(makeConfig(), []);
    expect(fs.existsSync(wpiProfilePath(tmpHome))).toBe(true);
    fs.rmSync(wpiProfilePath(tmpHome));
    await backend.shell(makeConfig());
    expect(fs.existsSync(wpiProfilePath(tmpHome))).toBe(true);
  });
});

describe("DockerBackend dry-run rendering", () => {
  it("renders plain docker commands with the in-container nono note", () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => out.push(args.join(" ")));
    backend.dryRun(makeConfig(), []);
    spy.mockRestore();

    const text = out.join("\n");
    expect(text).toContain("docker run");
    expect(text).toContain("docker build");
    expect(text).not.toContain("nono run --profile wpi-docker");
    expect(text).toContain("nono wraps pi inside the container");
    expect(text).toContain("PI_SANDBOX=nono");
  });

  it("renders the unsandboxed note for sandbox: none", () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => out.push(args.join(" ")));
    backend.dryRun(makeConfig({ sandboxBackend: "none" }), []);
    spy.mockRestore();

    const text = out.join("\n");
    expect(text).toContain("docker run");
    expect(text).toContain("sandbox: none (unsandboxed)");
    expect(text).toContain("PI_SANDBOX=none");
  });
});

describe("DockerBackend.setup (in-container nono)", () => {
  it("docker+nono: verifies cli+daemon, notes in-container nono, ensures profile (exit 0)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2";
      throw new Error("unexpected: " + cmd);
    });
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: "29.7.2", stderr: "", pid: 0, output: [], signal: null } as never);

    const report = await backend.setup(makeConfig());
    expect(report.exitCode).toBe(0);
    expect(report.steps.map((s) => s.label)).toEqual(["docker cli", "docker daemon", "nono in container", "wpi profile"]);
    expect(fs.existsSync(wpiProfilePath(tmpHome))).toBe(true);
  });

  it("docker+none: warns unsandboxed, no profile (exit 1)", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "docker --version") return "Docker version 29.7.2";
      throw new Error("unexpected: " + cmd);
    });
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: "29.7.2", stderr: "", pid: 0, output: [], signal: null } as never);

    const report = await backend.setup(makeConfig({ sandboxBackend: "none" }));
    expect(report.exitCode).toBe(1);
    expect(report.steps.map((s) => s.label)).toEqual(["docker cli", "docker daemon", "unsandboxed"]);
    expect(fs.existsSync(wpiProfilePath(tmpHome))).toBe(false);
  });
});

describe("DockerBackend.doctor sandbox section", () => {
  it("docker+nono: reports in-container nono + profile drift state (exit 0 when in sync)", async () => {
    backend.build(makeConfig()); // write the canonical profile
    const report = await backend.doctor(makeConfig());
    const sandbox = report.sections.find((s) => s.name === "Sandbox")!;
    expect(sandbox.checks.find((c) => c.label === "backend")?.detail).toBe("nono (in-container)");
    expect(sandbox.checks.find((c) => c.label === "profile drift")?.status).toBe("ok");
    expect(report.exitCode).toBe(0);
  });

  it("warns on drifted profile", async () => {
    backend.build(makeConfig());
    const p = wpiProfilePath(tmpHome);
    const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
    onDisk.meta.version = "0.0.0";
    fs.writeFileSync(p, JSON.stringify(onDisk));

    const report = await backend.doctor(makeConfig());
    const sandbox = report.sections.find((s) => s.name === "Sandbox")!;
    expect(sandbox.checks.find((c) => c.label === "profile drift")?.status).toBe("warn");
  });

  it("reports info when the profile is not yet written", async () => {
    const report = await backend.doctor(makeConfig());
    const sandbox = report.sections.find((s) => s.name === "Sandbox")!;
    expect(sandbox.checks.find((c) => c.label === "profile drift")?.status).toBe("info");
  });
});
