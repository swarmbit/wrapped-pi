// ============================================================
// Tests for DockerBackend sandbox wrapping — Phase 4
// ============================================================
// Covers:
//   - docker+nono: every docker invocation goes through nono
//     (`nono run --profile wpi-docker --allow-cwd --rollback -- docker ...`)
//   - nonoPrefix honours nono.dockerProfile
//   - dry-run renders the wrapped command for nono, plain for none
//   - enableSandboxOrWarn fails fast when a drifted on-disk profile
//     misses a declared mount/socket grant (plan: "mount the profile
//     doesn't grant is a setup/doctor error, not a runtime failure")
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DockerBackend } from "./docker-backend";
import type { ResolvedConfig } from "./backend";
import { PI_VERSION, PI_IMAGE, EMPTY_NETWORK, DEFAULT_DOCKER_SOCKET } from "../config";

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
import {
  buildImage,
  imageExists,
  setDockerSandboxPrefix,
} from "../docker";
import { wpiDockerProfilePath, WPI_DOCKER_PROFILE_NAME } from "./docker-profile";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedBuildImage = vi.mocked(buildImage);

const NONO_PREFIX = ["run", "--profile", WPI_DOCKER_PROFILE_NAME, "--allow-cwd", "--rollback"];

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    runtimeMode: "docker",
    sandboxBackend: "nono",
    network: EMPTY_NETWORK,
    workspace: { allowPaths: [], readPaths: [] },
    nono: { allowPaths: [], readPaths: [], dockerProfile: WPI_DOCKER_PROFILE_NAME },
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
  };
}

let tmpHome: string;
let backend: DockerBackend;

beforeEach(() => {
  vi.clearAllMocks();
  setDockerSandboxPrefix([]); // module state must not leak between tests
  backend = new DockerBackend();
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-docker-backend-")));
  vi.stubEnv("HOME", tmpHome);
  // docker + nono --version probes succeed by default; spawnSync returns a
  // successful (status 0) result so imageExists treats images as present.
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
  setDockerSandboxPrefix([]);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("DockerBackend sandbox wrapping", () => {
  it("build() arms the nono prefix so docker calls run under nono", () => {
    backend.build(makeConfig());
    expect(mockedBuildImage).toHaveBeenCalledTimes(1);
    // The real imageExists path in docker.ts must now spawn via nono.
    imageExists("pi-agent:test");
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "nono",
      [...NONO_PREFIX, "--", "docker", "image", "inspect", "pi-agent:test"],
      expect.anything()
    );
  });

  it("uses nono.dockerProfile for the sandbox profile name", () => {
    backend.build(makeConfig({ nono: { allowPaths: [], readPaths: [], dockerProfile: "team-docker" } }));
    imageExists("pi-agent:test");
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "nono",
      ["run", "--profile", "team-docker", "--allow-cwd", "--rollback", "--", "docker", "image", "inspect", "pi-agent:test"],
      expect.anything()
    );
    // The authored profile lives at team-docker.json.
    expect(fs.existsSync(wpiDockerProfilePath(tmpHome, "team-docker"))).toBe(true);
  });

  it("does NOT arm the prefix for sandbox: none (bare docker)", () => {
    backend.build(makeConfig({ sandboxBackend: "none" }));
    expect(mockedBuildImage).toHaveBeenCalledTimes(1);
    imageExists("pi-agent:test");
    expect(mockedSpawnSync).toHaveBeenCalledWith("docker", ["image", "inspect", "pi-agent:test"], expect.anything());
  });

  it("writes the wpi-docker profile on first sandboxed dispatch", () => {
    backend.build(makeConfig());
    const p = wpiDockerProfilePath(tmpHome);
    expect(fs.existsSync(p)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(onDisk.meta.name).toBe(WPI_DOCKER_PROFILE_NAME);
    expect(onDisk.filesystem.unix_socket).toContain(DEFAULT_DOCKER_SOCKET);
  });
});

describe("DockerBackend dry-run rendering (Phase 4)", () => {
  it("renders the nono-wrapped docker run + build commands", () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => out.push(args.join(" ")));
    backend.dryRun(makeConfig(), []);
    spy.mockRestore();

    const text = out.join("\n");
    expect(text).toContain(`nono ${NONO_PREFIX.join(" ")} -- docker run`);
    expect(text).toContain("profile: wpi-docker (extends default; scopes docker client)");
    expect(text).toContain(`socket:  ${DEFAULT_DOCKER_SOCKET}`);
    expect(text).toContain(`nono ${NONO_PREFIX.join(" ")} -- docker build`);
  });

  it("renders bare docker commands for sandbox: none", () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => out.push(args.join(" ")));
    backend.dryRun(makeConfig({ sandboxBackend: "none" }), []);
    spy.mockRestore();

    const text = out.join("\n");
    expect(text).toContain("Docker run command:");
    expect(text).toContain("docker run");
    expect(text).not.toContain("nono");
  });
});

describe("DockerBackend mount-grant fail-fast", () => {
  it("exits 1 when a drifted on-disk profile misses a declared mount grant", () => {
    // A stale on-disk profile that grants the socket but no mounts.
    const profilePath = wpiDockerProfilePath(tmpHome);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(
      profilePath,
      JSON.stringify({
        meta: { name: WPI_DOCKER_PROFILE_NAME, version: "0.0.0" },
        extends: "default",
        filesystem: { unix_socket: [DEFAULT_DOCKER_SOCKET] },
      })
    );

    const config = makeConfig({ mounts: [{ host: "/host/data", container: "/container/data", mode: "rw" }] });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let threw = "";
    let errOutput = "";
    try {
      backend.build(config);
    } catch (e) {
      threw = (e as Error).message;
    }
    errOutput = errSpy.mock.calls.flat().join(" ");
    exitSpy.mockRestore();
    errSpy.mockRestore();

    expect(threw).toBe("process.exit(1)");
    expect(mockedBuildImage).not.toHaveBeenCalled();
    expect(errOutput).toContain("/host/data");
    expect(errOutput.toLowerCase()).toContain("delete the profile to regenerate");
  });

  it("does NOT fail when a drifted profile still grants everything declared", () => {
    const profilePath = wpiDockerProfilePath(tmpHome);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    // Drifted content (different meta) but the mount grant is present.
    fs.writeFileSync(
      profilePath,
      JSON.stringify({
        meta: { name: WPI_DOCKER_PROFILE_NAME, version: "0.0.0" },
        extends: "default",
        filesystem: { unix_socket: [DEFAULT_DOCKER_SOCKET], allow: ["/host/data"] },
      })
    );

    const config = makeConfig({ mounts: [{ host: "/host/data", container: "/container/data", mode: "rw" }] });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    backend.build(config);
    exitSpy.mockRestore();
    errSpy.mockRestore();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockedBuildImage).toHaveBeenCalledTimes(1);
  });
});
