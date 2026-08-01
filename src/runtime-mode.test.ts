// ============================================================
// Tests for runtime mode resolution — Phase 0 (runtime.mode + --mode)
// ============================================================
// Covers:
//   - default mode (docker) with no config
//   - parsing runtime.mode from project and user config
//   - precedence: CLI flag > user config > project config > default
//   - invalid mode rejection from every source (CLI, user, project)
//   - error messages identify the source of the invalid value

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  loadConfig,
  parseRuntimeMode,
  RUNTIME_MODES,
  DEFAULT_RUNTIME_MODE,
} from "./config";

let tmpDir: string;
let homeDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-mode-project-")));
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-mode-home-")));
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function writeProjectConfig(yamlBody: string): void {
  const containerDir = path.join(tmpDir, ".pi");
  fs.mkdirSync(containerDir, { recursive: true });
  fs.writeFileSync(path.join(containerDir, "wpi.yml"), yamlBody);
}

function writeUserConfig(yamlBody: string): void {
  fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".pi", "wpi.yml"), yamlBody);
}

describe("parseRuntimeMode", () => {
  it("accepts every declared runtime mode", () => {
    for (const mode of RUNTIME_MODES) {
      expect(parseRuntimeMode(mode, "test")).toBe(mode);
    }
  });

  it("rejects an unknown mode with a source-labeled error", () => {
    expect(() => parseRuntimeMode("podman", "my-source")).toThrow(
      'Invalid runtime mode "podman" in my-source. Expected one of: docker, nono.'
    );
  });

  it("rejects empty string", () => {
    expect(() => parseRuntimeMode("", "test")).toThrow(/Invalid runtime mode/);
  });

  it("is case-sensitive (DOCKER is invalid)", () => {
    expect(() => parseRuntimeMode("DOCKER", "test")).toThrow(/Invalid runtime mode/);
  });
});

describe("runtime mode defaults", () => {
  it("DEFAULT_RUNTIME_MODE is docker (backwards compatibility)", () => {
    expect(DEFAULT_RUNTIME_MODE).toBe("docker");
  });

  it("defaults to docker when no config exists", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.runtimeMode).toBe("docker");
  });

  it("defaults to docker when config files have no runtime section", () => {
    writeProjectConfig("docker:\n  env:\n    FOO: bar");
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.runtimeMode).toBe("docker");
  });
});

describe("runtime mode from config files", () => {
  it("reads runtime.mode from project config", () => {
    writeProjectConfig("runtime:\n  mode: nono");
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.runtimeMode).toBe("nono");
  });

  it("reads runtime.mode from user config", () => {
    writeUserConfig("runtime:\n  mode: nono");
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.runtimeMode).toBe("nono");
  });

  it("user config wins over project config", () => {
    writeProjectConfig("runtime:\n  mode: docker");
    writeUserConfig("runtime:\n  mode: nono");
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.runtimeMode).toBe("nono");
  });

  it("coexists with other config sections without disturbing them", () => {
    writeProjectConfig(
      "runtime:\n  mode: nono\ndocker:\n  env:\n    ANTHROPIC_API_KEY: sk-test\n  memory: 4g"
    );
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir });
    expect(config.runtimeMode).toBe("nono");
    expect(config.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config.memory).toBe("4g");
  });
});

describe("runtime mode CLI override (--mode)", () => {
  it("CLI flag overrides user config", () => {
    writeUserConfig("runtime:\n  mode: nono");
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir, cliMode: "docker" });
    expect(config.runtimeMode).toBe("docker");
  });

  it("CLI flag overrides project config", () => {
    writeProjectConfig("runtime:\n  mode: docker");
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir, cliMode: "nono" });
    expect(config.runtimeMode).toBe("nono");
  });

  it("CLI flag applies when no config files exist", () => {
    process.chdir(tmpDir);
    const config = loadConfig({ homeDir, cliMode: "nono" });
    expect(config.runtimeMode).toBe("nono");
  });

  it("CLI override does not mutate config files", () => {
    writeProjectConfig("runtime:\n  mode: docker");
    process.chdir(tmpDir);
    loadConfig({ homeDir, cliMode: "nono" });
    const onDisk = fs.readFileSync(path.join(tmpDir, ".pi", "wpi.yml"), "utf-8");
    expect(onDisk).toBe("runtime:\n  mode: docker");
  });
});

describe("invalid runtime mode rejection", () => {
  it("rejects invalid mode in project config, naming the file", () => {
    writeProjectConfig("runtime:\n  mode: podman");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(
      new RegExp(`Invalid runtime mode "podman" in .*\\.pi/wpi\\.yml`)
    );
  });

  it("rejects invalid mode in user config, naming the file", () => {
    writeUserConfig("runtime:\n  mode: podman");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(
      new RegExp(`Invalid runtime mode "podman" in .*\\.pi/wpi\\.yml`)
    );
  });

  it("rejects invalid CLI --mode value, naming the flag", () => {
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir, cliMode: "podman" })).toThrow(
      'Invalid runtime mode "podman" in --mode flag. Expected one of: docker, nono.'
    );
  });

  it("invalid user config still surfaces even when project config is valid", () => {
    writeProjectConfig("runtime:\n  mode: docker");
    writeUserConfig("runtime:\n  mode: podman");
    process.chdir(tmpDir);
    // user config has higher precedence, so its invalid value is the one resolved
    expect(() => loadConfig({ homeDir })).toThrow(/Invalid runtime mode "podman"/);
  });

  it("invalid project config is masked when a valid CLI flag wins", () => {
    writeProjectConfig("runtime:\n  mode: podman");
    process.chdir(tmpDir);
    // CLI outranks project config — the invalid project value is never resolved
    const config = loadConfig({ homeDir, cliMode: "nono" });
    expect(config.runtimeMode).toBe("nono");
  });
});
