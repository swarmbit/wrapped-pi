// ============================================================
// Tests for sandbox.backend parsing & precedence (Phase 3/4)
// ============================================================
// Covers:
//   - parseSandboxBackend accepts declared backends; rejects unknown/empty
//   - DEFAULT_SANDBOX_FOR: docker→nono (Phase 4), host→nono
//   - isSandboxImplemented: all four combinations implemented as of Phase 4
//   - loadConfig resolves sandboxBackend with precedence CLI > user > project
//     > mode-default
//   - docker+nono accepted (Phase 4)
//   - nono.dockerProfile resolution (project > user > default wpi-docker)
//   - docker.socket resolution (config > $DOCKER_HOST unix:// > default)
//   - invalid values rejected from each source with source-labeled errors
//   - CLI override never writes back
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  loadConfig,
  parseSandboxBackend,
  SANDBOX_BACKENDS,
  DEFAULT_SANDBOX_FOR,
  isSandboxImplemented,
} from "./config";

let tmpDir: string;
let homeDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-sbx-project-")));
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-sbx-home-")));
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function writeProjectConfig(yamlBody: string): void {
  const dir = path.join(tmpDir, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wpi.yml"), yamlBody);
}

function writeUserConfig(yamlBody: string): void {
  fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".pi", "wpi.yml"), yamlBody);
}

describe("parseSandboxBackend", () => {
  it("accepts every declared backend", () => {
    for (const b of SANDBOX_BACKENDS) {
      expect(parseSandboxBackend(b, "test")).toBe(b);
    }
  });

  it("rejects unknown backend with source-labeled error", () => {
    expect(() => parseSandboxBackend("gvisor", "my-source")).toThrow(
      'Invalid sandbox backend "gvisor" in my-source. Expected one of: nono, none.'
    );
  });

  it("rejects empty and uppercase (case-sensitive)", () => {
    expect(() => parseSandboxBackend("", "test")).toThrow(/Invalid sandbox backend/);
    expect(() => parseSandboxBackend("NONO", "test")).toThrow(/Invalid sandbox backend/);
  });
});

describe("DEFAULT_SANDBOX_FOR & isSandboxImplemented (Phase 4)", () => {
  it("docker defaults to nono in Phase 4 (breaking, plan §0.1)", () => {
    expect(DEFAULT_SANDBOX_FOR.docker).toBe("nono");
  });

  it("host defaults to nono", () => {
    expect(DEFAULT_SANDBOX_FOR.host).toBe("nono");
  });

  it("all four combinations are implemented as of Phase 4", () => {
    expect(isSandboxImplemented("docker", "none")).toBe(true);
    expect(isSandboxImplemented("docker", "nono")).toBe(true);
    expect(isSandboxImplemented("host", "nono")).toBe(true);
    expect(isSandboxImplemented("host", "none")).toBe(true);
  });
});

describe("sandboxBackend resolution", () => {
  it("defaults to nono for docker with no config (Phase 4)", () => {
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).sandboxBackend).toBe("nono");
  });

  it("defaults to nono for host mode (via cliMode)", () => {
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir, cliMode: "host" }).sandboxBackend).toBe("nono");
  });

  it("reads sandbox.backend from project config", () => {
    writeProjectConfig("sandbox:\n  backend: none\nruntime:\n  mode: host");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).sandboxBackend).toBe("none");
  });

  it("reads sandbox.backend from user config", () => {
    writeUserConfig("sandbox:\n  backend: none\nruntime:\n  mode: host");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).sandboxBackend).toBe("none");
  });

  it("CLI --sandbox overrides user and project config", () => {
    writeUserConfig("sandbox:\n  backend: none\nruntime:\n  mode: host");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir, cliSandbox: "none", cliMode: "host" }).sandboxBackend).toBe("none");
    // flip: user says none, CLI says nono
    expect(loadConfig({ homeDir, cliSandbox: "nono", cliMode: "host" }).sandboxBackend).toBe("nono");
  });

  it("CLI --sandbox applies with no config files", () => {
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir, cliSandbox: "none", cliMode: "host" }).sandboxBackend).toBe("none");
  });

  it("user config wins over project config", () => {
    writeProjectConfig("sandbox:\n  backend: none\nruntime:\n  mode: host");
    writeUserConfig("sandbox:\n  backend: nono\nruntime:\n  mode: host");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).sandboxBackend).toBe("nono");
  });

  it("CLI override does not mutate config files", () => {
    writeProjectConfig("sandbox:\n  backend: none\nruntime:\n  mode: host");
    process.chdir(tmpDir);
    loadConfig({ homeDir, cliSandbox: "nono", cliMode: "host" });
    const onDisk = fs.readFileSync(path.join(tmpDir, ".pi", "wpi.yml"), "utf-8");
    expect(onDisk).toBe("sandbox:\n  backend: none\nruntime:\n  mode: host");
  });
});

describe("invalid sandbox rejection", () => {
  it("rejects invalid backend in project config, naming the file", () => {
    writeProjectConfig("sandbox:\n  backend: gvisor");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(
      new RegExp(`Invalid sandbox backend "gvisor" in .*\\.pi/wpi\\.yml`)
    );
  });

  it("rejects invalid backend in user config, naming the file", () => {
    writeUserConfig("sandbox:\n  backend: gvisor");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(
      new RegExp(`Invalid sandbox backend "gvisor" in .*\\.pi/wpi\\.yml`)
    );
  });

  it("rejects invalid CLI --sandbox value, naming the flag", () => {
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir, cliSandbox: "gvisor", cliMode: "host" })).toThrow(
      'Invalid sandbox backend "gvisor" in --sandbox flag. Expected one of: nono, none.'
    );
  });
});

describe("docker+nono accepted (Phase 4)", () => {
  it("accepts docker+nono from config", () => {
    writeProjectConfig("sandbox:\n  backend: nono\nruntime:\n  mode: docker");
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir });
    expect(cfg.runtimeMode).toBe("docker");
    expect(cfg.sandboxBackend).toBe("nono");
  });

  it("accepts docker+nono from CLI --sandbox", () => {
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir, cliSandbox: "nono", cliMode: "docker" });
    expect(cfg.sandboxBackend).toBe("nono");
  });

  it("allows docker+none (opt-out, no error)", () => {
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir, cliSandbox: "none", cliMode: "docker" });
    expect(cfg.runtimeMode).toBe("docker");
    expect(cfg.sandboxBackend).toBe("none");
  });

  it("allows host+none (opt-out) without error", () => {
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir, cliSandbox: "none", cliMode: "host" });
    expect(cfg.runtimeMode).toBe("host");
    expect(cfg.sandboxBackend).toBe("none");
  });
});

describe("nono.dockerProfile resolution (Phase 4)", () => {
  it("defaults to wpi-docker", () => {
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).nono.dockerProfile).toBe("wpi-docker");
  });

  it("reads nono.dockerProfile from project config", () => {
    writeProjectConfig("nono:\n  dockerProfile: team-docker");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).nono.dockerProfile).toBe("team-docker");
  });

  it("project config wins over user config (docker.* convention)", () => {
    writeProjectConfig("nono:\n  dockerProfile: project-docker");
    writeUserConfig("nono:\n  dockerProfile: user-docker");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).nono.dockerProfile).toBe("project-docker");
  });
});

describe("docker.socket resolution (Phase 4)", () => {
  it("defaults to /var/run/docker.sock", () => {
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).dockerSocket).toBe("/var/run/docker.sock");
  });

  it("reads docker.socket from project config", () => {
    writeProjectConfig("docker:\n  socket: /tmp/colima.sock");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).dockerSocket).toBe("/tmp/colima.sock");
  });

  it("honours $DOCKER_HOST when it is a unix socket", () => {
    process.chdir(tmpDir);
    process.env.DOCKER_HOST = "unix:///var/run/other.sock";
    try {
      expect(loadConfig({ homeDir }).dockerSocket).toBe("/var/run/other.sock");
    } finally {
      delete process.env.DOCKER_HOST;
    }
  });

  it("explicit config wins over $DOCKER_HOST", () => {
    writeProjectConfig("docker:\n  socket: /custom.sock");
    process.chdir(tmpDir);
    process.env.DOCKER_HOST = "unix:///var/run/other.sock";
    try {
      expect(loadConfig({ homeDir }).dockerSocket).toBe("/custom.sock");
    } finally {
      delete process.env.DOCKER_HOST;
    }
  });

  it("ignores non-unix $DOCKER_HOST (falls back to default)", () => {
    process.chdir(tmpDir);
    process.env.DOCKER_HOST = "tcp://127.0.0.1:2375";
    try {
      expect(loadConfig({ homeDir }).dockerSocket).toBe("/var/run/docker.sock");
    } finally {
      delete process.env.DOCKER_HOST;
    }
  });
});