// ============================================================
// Tests for network.* / workspace.* / nono.* config mapping (Phase 3 commit 2)
// ============================================================
// Covers resolution & validation of the new config sections that feed the nono
// profile: allowDomains, credentials (preset validation), customCredentials
// merge, network mode, and workspace/nono fs-grant arrays.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { loadConfig } from "./config";

let tmpDir: string;
let homeDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-net-project-")));
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-net-home-")));
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function writeProject(body: string): void {
  const dir = path.join(tmpDir, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wpi.yml"), body);
}
function writeUser(body: string): void {
  fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".pi", "wpi.yml"), body);
}

describe("network resolution", () => {
  it("defaults to mode filtered, empty allowDomains/credentials", () => {
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir, cliMode: "host" });
    expect(cfg.network.mode).toBe("filtered");
    expect(cfg.network.allowDomains).toEqual([]);
    expect(cfg.network.credentials).toEqual([]);
    expect(cfg.network.customCredentials).toEqual({});
  });

  it("reads allowDomains from project config", () => {
    writeProject("runtime:\n  mode: host\nnetwork:\n  allowDomains:\n    - api.anthropic.com\n    - github.com");
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir });
    expect(cfg.network.allowDomains).toEqual(["api.anthropic.com", "github.com"]);
  });

  it("merges project + user allowDomains (deduped, stable order)", () => {
    writeProject("runtime:\n  mode: host\nnetwork:\n  allowDomains:\n    - api.anthropic.com\n    - shared.example.com");
    writeUser("runtime:\n  mode: host\nnetwork:\n  allowDomains:\n    - github.com\n    - shared.example.com");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).network.allowDomains).toEqual([
      "api.anthropic.com",
      "shared.example.com",
      "github.com",
    ]);
  });

  it("reads preset credentials and validates them", () => {
    writeProject("runtime:\n  mode: host\nnetwork:\n  credentials:\n    - anthropic\n    - github");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).network.credentials).toEqual(["anthropic", "github"]);
  });

  it("rejects an unknown preset credential service", () => {
    writeProject("runtime:\n  mode: host\nnetwork:\n  credentials:\n    - firecrawl");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(/Invalid credential service "firecrawl"/);
  });

  it("merges customCredentials user-over-project", () => {
    writeProject(
      "runtime:\n  mode: host\nnetwork:\n  customCredentials:\n    firecrawl:\n      upstream: https://api.firecrawl.dev\n      credentialKey: fc1\n      envVar: FIRECRAWL_API_KEY"
    );
    writeUser(
      "runtime:\n  mode: host\nnetwork:\n  customCredentials:\n    firecrawl:\n      upstream: https://api.firecrawl.dev\n      credentialKey: fc2\n      envVar: FIRECRAWL_API_KEY\n      credentialFormat: Bearer {}"
    );
    process.chdir(tmpDir);
    const cc = loadConfig({ homeDir }).network.customCredentials;
    expect(cc.firecrawl.credentialKey).toBe("fc2"); // user overrides
    expect(cc.firecrawl.credentialFormat).toBe("Bearer {}");
  });

  it("rejects invalid network mode", () => {
    writeProject("runtime:\n  mode: host\nnetwork:\n  mode: stealth");
    process.chdir(tmpDir);
    expect(() => loadConfig({ homeDir })).toThrow(/Invalid network mode "stealth"/);
  });

  it("accepts mode: blocked", () => {
    writeProject("runtime:\n  mode: host\nnetwork:\n  mode: blocked");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).network.mode).toBe("blocked");
  });
});

describe("workspace / nono resolution", () => {
  it("defaults to empty grants", () => {
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir, cliMode: "host" });
    expect(cfg.workspace.allowPaths).toEqual([]);
    expect(cfg.workspace.readPaths).toEqual([]);
    expect(cfg.nono.allowPaths).toEqual([]);
    expect(cfg.nono.readPaths).toEqual([]);
  });

  it("merges workspace + nono allowPaths are separate but both feed the profile", () => {
    writeProject("runtime:\n  mode: host\nworkspace:\n  allowPaths:\n    - ~/src\nnono:\n  allowPaths:\n    - /tmp/build");
    process.chdir(tmpDir);
    const cfg = loadConfig({ homeDir });
    expect(cfg.workspace.allowPaths).toEqual(["~/src"]);
    expect(cfg.nono.allowPaths).toEqual(["/tmp/build"]);
  });

  it("reads readPaths and dedupes within a section", () => {
    writeProject("runtime:\n  mode: host\nworkspace:\n  readPaths:\n    - /etc\n    - /etc\n    - /usr/share");
    process.chdir(tmpDir);
    expect(loadConfig({ homeDir }).workspace.readPaths).toEqual(["/etc", "/usr/share"]);
  });
});