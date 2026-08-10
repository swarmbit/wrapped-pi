// ============================================================
// Tests for sandbox.backend parsing & precedence (Phase 3)
// ============================================================
// Covers:
//   - parseSandboxBackend accepts declared backends; rejects unknown/empty
//   - DEFAULT_SANDBOX_FOR: docker→none (Phase 3), host→nono
//   - isSandboxImplemented: docker+none yes, docker+nono no (Phase 4),
//     host+nono yes, host+none yes
//   - loadConfig resolves sandboxBackend with precedence CLI > user > project
//     > mode-default
//   - docker+nono rejected in Phase 3 with an actionable error
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

describe("DEFAULT_SANDBOX_FOR & isSandboxImplemented (Phase 3)", () => {
  it("docker defaults to none in Phase 3 (docker+nono lands in Phase 4)", () => {
    expect(DEFAULT_SANDBOX_FOR.docker).toBe("none");
  });

  it("host defaults to nono in Phase 3", () => {
    expect(DEFAULT_SANDBOX_FOR.host).toBe("nono");
  });

  it("docker+none is implemented; docker+nono is NOT (Phase 4)", () => {
    expect(isSandboxImplemented("docker", "none")).toBe(true);
    expect(isSandboxImplemented("docker", "nono")).toBe(false);
  });

  it("host+nono and host+none are both implemented", () => {
    expect(isSandboxImplemented("host", "nono")).toBe(true);
    expect(isSandboxImplemented("host", "none")).toBe(true);
  });
});

describe("sandboxBackend resolution", () => {
  it("defaults to none for docker with no config", () => {
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).sandboxBackend).toBe("none");
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

describe("docker+nono Phase 3 guard", () => {
  it("rejects docker+nono from config with an actionable Phase 4 message", () => {
    writeProjectConfig("sandbox:\n  backend: nono\nruntime:\n  mode: docker");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(/docker \+ nono lands in Phase 4/);
  });

  it("rejects docker+nono from CLI --sandbox", () => {
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir, cliSandbox: "nono", cliMode: "docker" })).toThrow(
      /not implemented for runtime mode "docker"/
    );
  });

  it("allows host+none (opt-out) without error", () => {
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir, cliSandbox: "none", cliMode: "host" });
    expect(cfg.runtimeMode).toBe("host");
    expect(cfg.sandboxBackend).toBe("none");
  });
});