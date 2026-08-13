// ============================================================
// Tests for nono-pack.ts — nolabs-ai/pi pack wiring check
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { nonoPackDir, isNonoPackWired } from "./nono-pack";

let homeDir: string;
let settingsPath: string;

beforeEach(() => {
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-nono-pack-")));
  settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function writeSettings(packages: unknown[]): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ packages }));
}

describe("nonoPackDir", () => {
  it("resolves the registry pack install dir", () => {
    expect(nonoPackDir(homeDir)).toBe(path.join(homeDir, ".config", "nono", "packages", "nolabs-ai", "pi"));
  });
});

describe("isNonoPackWired", () => {
  it("is false when settings do not exist", () => {
    expect(isNonoPackWired(settingsPath, homeDir)).toBe(false);
  });

  it("is true for the object-form source entry nono appends on pull", () => {
    writeSettings([{ source: nonoPackDir(homeDir) }]);
    expect(isNonoPackWired(settingsPath, homeDir)).toBe(true);
  });

  it("is true for a plain string entry", () => {
    writeSettings([nonoPackDir(homeDir)]);
    expect(isNonoPackWired(settingsPath, homeDir)).toBe(true);
  });

  it("ignores unrelated entries", () => {
    writeSettings(["/home/user/.pi/.wpi/package", { source: "npm:other" }]);
    expect(isNonoPackWired(settingsPath, homeDir)).toBe(false);
  });

  it("is false when settings are malformed", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ not json");
    expect(isNonoPackWired(settingsPath, homeDir)).toBe(false);
  });
});
