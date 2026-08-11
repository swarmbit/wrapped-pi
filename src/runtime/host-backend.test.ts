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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HostBackend } from "./host-backend";
import type { ResolvedConfig } from "./backend";
import { PI_VERSION, PI_IMAGE, EMPTY_NETWORK, EMPTY_NONO, DEFAULT_DOCKER_SOCKET } from "../config";

// Mock child_process so commandAvailable / version probes are deterministic and
// never hang on a real pi/nono binary in the test environment.
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));
import { execSync, spawn } from "child_process";
const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);

function makeHostConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    runtimeMode: "host",
    sandboxBackend: "nono",
    network: EMPTY_NETWORK,
    workspace: EMPTY_NONO,
    nono: EMPTY_NONO,
    dockerSocket: DEFAULT_DOCKER_SOCKET,
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
    expect(out).toContain("profile: wpi (extends nolabs-ai/pi)");
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

  it("produces sections Runtime, Sandbox, Profile, Pi, Platform, Package, Configuration (nono)", async () => {
    const report = await backend.doctor(makeHostConfig());
    expect(report.sections.map((s) => s.name)).toEqual([
      "Runtime",
      "Sandbox",
      "Profile",
      "Pi",
      "Platform",
      "Package",
      "Configuration",
    ]);
    expect(report.mode).toBe("host");
  });

  it("omits the Profile section when unsandboxed (host+none)", async () => {
    const report = await backend.doctor(makeHostConfig({ sandboxBackend: "none" }));
    expect(report.sections.map((s) => s.name)).toEqual([
      "Runtime",
      "Sandbox",
      "Pi",
      "Platform",
      "Package",
      "Configuration",
    ]);
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

describe("HostBackend.doctor — Profile section & route wins", () => {
  let backend: HostBackend;
  beforeEach(() => {
    vi.clearAllMocks();
    backend = new HostBackend();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      throw new Error("unexpected execSync: " + cmd);
    });
  });

  it("includes a Profile section with a drift check (ok/info/warn are all valid; doctor is read-only)", async () => {
    const report = await backend.doctor(makeHostConfig());
    const profile = report.sections.find((s) => s.name === "Profile");
    expect(profile).toBeDefined();
    const drift = profile!.checks.find((c) => c.label === "drift");
    // doctor never writes the profile; drift is ok (in sync), info (no file yet), or
    // warn (on-disk differs from canonical). Any of these is a valid read-only result.
    expect(["ok", "info", "warn"]).toContain(drift?.status);
  });

  it("reports enabled credential routes", async () => {
    const cfg = makeHostConfig({
      network: { ...EMPTY_NETWORK, credentials: ["anthropic", "github"] },
    });
    const report = await backend.doctor(cfg);
    const profile = report.sections.find((s) => s.name === "Profile")!;
    expect(profile.checks.find((c) => c.label === "credential routes")?.detail).toBe("anthropic, github");
  });

  it("route wins: warns when a secret env key is covered by a credential route", async () => {
    // Route covers ANTHROPIC_API_KEY, but the user also has it in env (docker.env). In host+nono
    // the real key is denied and a phantom is injected; doctor surfaces this.
    const cfg = makeHostConfig({
      network: { ...EMPTY_NETWORK, credentials: ["anthropic"] },
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    const report = await backend.doctor(cfg);
    const profile = report.sections.find((s) => s.name === "Profile")!;
    const leaking = profile.checks.find((c) => c.label === "env ANTHROPIC_API_KEY");
    expect(leaking?.status).toBe("warn");
    expect(leaking?.detail).toMatch(/real key denied in sandbox, phantom injected/);
  });

  it("route wins: flags host+none leak when a route covers a secret in env", async () => {
    const cfg = makeHostConfig({
      sandboxBackend: "none",
      network: { ...EMPTY_NETWORK, credentials: ["anthropic"] },
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    // sandbox=none omits the Profile section, but the Configuration section still
    // surfaces the secret env; the route-wins warning belongs to the Profile section,
    // which is absent here. Verify the secret is still flagged somewhere (Configuration).
    const report = await backend.doctor(cfg);
    const cfgSection = report.sections.find((s) => s.name === "Configuration")!;
    expect(cfgSection.checks.some((c) => c.label === "env ANTHROPIC_API_KEY")).toBe(true);
  });

  it("does not warn about env keys not covered by any route", async () => {
    const cfg = makeHostConfig({
      network: { ...EMPTY_NETWORK, credentials: ["anthropic"] },
      env: { OLLAMA_HOST: "http://x" }, // not a secret name; not route-covered
    });
    const report = await backend.doctor(cfg);
    const profile = report.sections.find((s) => s.name === "Profile")!;
    expect(profile.checks.some((c) => c.label === "env OLLAMA_HOST")).toBe(false);
  });
});
// ── HostBackend — Phase 5 package wiring ─────────────────────

import {
  ensureWpiPackageCopy,
  wireSettings,
  wpiPackageDir,
  agentSettingsPath,
} from "./package-wiring";

describe("HostBackend — Package section (doctor, read-only)", () => {
  let backend: HostBackend;
  let tmpHome: string;
  let tmpSource: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-host-home-")));
    tmpSource = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-host-src-")));
    vi.stubEnv("HOME", tmpHome);
    fs.mkdirSync(path.join(tmpSource, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSource, "package.json"),
      JSON.stringify({ name: "wpi-defaults", wpi: { nativeBinaries: ["git"] } })
    );
    fs.writeFileSync(path.join(tmpSource, "extensions/sample.ts"), "export const x = 1;\n");
    backend = new HostBackend({ packageSourceDir: tmpSource });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpSource, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function hostConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return makeHostConfig({ configDir: path.join(tmpHome, ".pi"), ...overrides });
  }

  it("reports not-present copy, will-wire settings, and missing native binary", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      throw new Error("unexpected: " + cmd); // git --version → missing
    });
    const report = await backend.doctor(hostConfig());
    const pkg = report.sections.find((s) => s.name === "Package")!;
    expect(pkg.checks.find((c) => c.label === "package copy")?.status).toBe("info");
    expect(pkg.checks.find((c) => c.label === "settings")?.detail).toMatch(/will be created on first run/);
    expect(pkg.checks.find((c) => c.label === "binary git")?.status).toBe("error");
  });

  it("reports in-sync copy, wired settings, and found native binary", async () => {
    // Pre-wire exactly what a first run would write (doctor itself never writes).
    ensureWpiPackageCopy(tmpSource, tmpHome, "1.0.0");
    wireSettings(agentSettingsPath(path.join(tmpHome, ".pi")), wpiPackageDir(tmpHome, "1.0.0"), tmpHome);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "pi --version") return "pi 0.84.1";
      if (cmd === "nono --version") return "nono 0.73.0";
      if (cmd === "git --version") return "git version 2.39.0";
      throw new Error("unexpected: " + cmd);
    });

    const report = await backend.doctor(hostConfig());
    const pkg = report.sections.find((s) => s.name === "Package")!;
    expect(pkg.checks.find((c) => c.label === "package copy")?.status).toBe("ok");
    expect(pkg.checks.find((c) => c.label === "settings")?.status).toBe("ok");
    expect(pkg.checks.find((c) => c.label === "binary git")?.status).toBe("ok");
  });

  it("warns on a collision between on-disk copy and bundled source", async () => {
    const dest = wpiPackageDir(tmpHome, "1.0.0");
    ensureWpiPackageCopy(tmpSource, tmpHome, "1.0.0");
    fs.writeFileSync(path.join(dest, "extensions/sample.ts"), "// user edit\n");

    const report = await backend.doctor(hostConfig());
    const pkg = report.sections.find((s) => s.name === "Package")!;
    const copy = pkg.checks.find((c) => c.label === "package copy")!;
    expect(copy.status).toBe("warn");
    expect(copy.detail).toMatch(/won't overwrite/);
  });

  it("reports (none declared) when the manifest declares no native binaries", async () => {
    fs.writeFileSync(path.join(tmpSource, "package.json"), JSON.stringify({ name: "wpi-defaults" }));
    const report = await backend.doctor(hostConfig());
    const pkg = report.sections.find((s) => s.name === "Package")!;
    expect(pkg.checks.find((c) => c.label === "native binaries")?.detail).toBe("(none declared)");
  });
});

describe("HostBackend — ensurePackageWiringOrWarn via build", () => {
  let backend: HostBackend;
  let tmpHome: string;
  let tmpSource: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-host-build-")));
    tmpSource = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-host-src2-")));
    vi.stubEnv("HOME", tmpHome);
    fs.mkdirSync(path.join(tmpSource, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(tmpSource, "package.json"), JSON.stringify({ name: "wpi-defaults" }));
    fs.writeFileSync(path.join(tmpSource, "extensions/sample.ts"), "export const x = 1;\n");
    // build() → checkPrerequisites probes pi; sandbox=none skips the profile.
    mockedExecSync.mockReturnValue("ok" as never);
    backend = new HostBackend({ packageSourceDir: tmpSource });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpSource, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("copies the bundled package and wires settings on first build", () => {
    const config = makeHostConfig({ configDir: path.join(tmpHome, ".pi"), sandboxBackend: "none" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    backend.build(config);
    const logged = logSpy.mock.calls.flat().join(" ");
    errSpy.mockRestore();
    logSpy.mockRestore();

    const dest = wpiPackageDir(tmpHome, "1.0.0");
    expect(fs.existsSync(path.join(dest, "extensions/sample.ts"))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(agentSettingsPath(path.join(tmpHome, ".pi")), "utf-8"));
    expect(settings.packages).toContain(dest);
    expect(logged).toContain("wired bundled package");
  });

  it("is idempotent: a second build reports in-sync and does not rewrite settings", () => {
    const config = makeHostConfig({ configDir: path.join(tmpHome, ".pi"), sandboxBackend: "none" });
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    backend.build(config);
    quiet.mockRestore();
    const settingsPath = agentSettingsPath(path.join(tmpHome, ".pi"));
    const before = fs.statSync(settingsPath).mtimeMs;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a.join(" ")));
    backend.build(config);
    spy.mockRestore();
    errSpy.mockRestore();

    expect(fs.statSync(settingsPath).mtimeMs).toBe(before);
    expect(logs.join(" ")).not.toContain("wired bundled package"); // no re-wire noise
  });
});

// ── HostBackend.shell per combination (Phase 7) ─────────────

describe("HostBackend.shell", () => {
  let backend: HostBackend;
  let tmpHome: string;
  let tmpSource: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-host-shell-")));
    tmpSource = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-host-shell-src-")));
    vi.stubEnv("HOME", tmpHome);
    fs.mkdirSync(path.join(tmpSource, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(tmpSource, "package.json"), JSON.stringify({ name: "wpi-defaults" }));
    fs.writeFileSync(path.join(tmpSource, "extensions/sample.ts"), "export const x = 1;\n");
    backend = new HostBackend({ packageSourceDir: tmpSource });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpSource, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("host+nono: launches `nono shell --profile wpi` (sandboxed interactive shell)", async () => {
    mockedExecSync.mockReturnValue("ok" as never); // pi/nono probes
    // spawnInherit resolves on child "close"; fire it synchronously with exit 0.
    const spawnSpy = mockedSpawn.mockImplementation((() => ({
      on: (event: string, cb: (code?: number) => void) => {
        if (event === "close") cb(0);
        return undefined;
      },
    })) as never);

    const config = makeHostConfig({ configDir: path.join(tmpHome, ".pi"), sandboxBackend: "nono" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await backend.shell(config);
    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(spawnSpy).toHaveBeenCalledWith("nono", ["shell", "--profile", "wpi", "--allow-cwd", "--rollback"], { stdio: "inherit" });
  });

  it("host+none: launches $SHELL natively with an unsandboxed notice", async () => {
    mockedExecSync.mockReturnValue("ok" as never);
    const spawnSpy = mockedSpawn.mockImplementation((() => ({
      on: (event: string, cb: (code?: number) => void) => {
        if (event === "close") cb(0);
        return undefined;
      },
    })) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.SHELL = "/bin/bash";

    await backend.shell(makeHostConfig({ configDir: path.join(tmpHome, ".pi"), sandboxBackend: "none" }));

    const errOutput = errSpy.mock.calls.flat().join(" ");
    logSpy.mockRestore();
    errSpy.mockRestore();
    expect(errOutput).toContain("UNSANDBOXED");
    expect(spawnSpy).toHaveBeenCalledWith("/bin/bash", ["/bin/bash"], { stdio: "inherit" });
  });
});
