// ============================================================
// Tests for package-wiring.ts — host-mode package wiring (Phase 5, A2)
// ============================================================
// Covers:
//   - wpiPackageDir: fixed hidden path (~/.pi/.wpi/package), no versioning
//   - ensureWpiPackageCopy: copied / in-sync / upgraded (replace wholesale)
//   - compareWpiPackage: read-only state for doctor
//   - wireSettings: append-only — adds our path, preserves user
//     packages/keys verbatim, no-ops when already wired, skips malformed
//     settings (no entry is ever removed)
//   - readNativeBinaries: parses the wpi.nativeBinaries manifest
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ensureWpiPackageCopy,
  compareWpiPackage,
  wireSettings,
  readNativeBinaries,
  wpiPackageDir,
  agentSettingsPath,
} from "./package-wiring";

let homeDir: string;
let sourceDir: string;
let settingsPath: string;

function writeSourceFile(rel: string, content: string): void {
  const p = path.join(sourceDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-pkg-home-")));
  sourceDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-pkg-src-")));
  settingsPath = agentSettingsPath(path.join(homeDir, ".pi"));
  // Default source: a minimal wpi-defaults package.
  writeSourceFile("package.json", JSON.stringify({ name: "wpi-defaults", wpi: { nativeBinaries: ["git"] } }));
  writeSourceFile("extensions/sample/index.ts", "export const x = 1;\n");
  writeSourceFile("themes/github.json", '{ "name": "github" }\n');
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
}

describe("wpiPackageDir / agentSettingsPath", () => {
  it("uses a single hidden path (no versioning)", () => {
    expect(wpiPackageDir(homeDir)).toBe(path.join(homeDir, ".pi", ".wpi", "package"));
  });

  it("points settings at ~/.pi/agent/settings.json", () => {
    expect(agentSettingsPath(path.join(homeDir, ".pi"))).toBe(path.join(homeDir, ".pi", "agent", "settings.json"));
  });
});

describe("ensureWpiPackageCopy", () => {
  it("copies the package to the hidden dir when absent", () => {
    const res = ensureWpiPackageCopy(sourceDir, homeDir);
    expect(res.action).toBe("copied");
    expect(res.differing).toEqual([]);
    expect(fs.existsSync(path.join(res.path, "extensions/sample/index.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(res.path, "themes/github.json"), "utf-8")).toBe('{ "name": "github" }\n');
  });

  it("reports in-sync on an identical second call (idempotent)", () => {
    ensureWpiPackageCopy(sourceDir, homeDir);
    const res = ensureWpiPackageCopy(sourceDir, homeDir);
    expect(res.action).toBe("in-sync");
  });

  it("replaces the copy wholesale when the bundled source changed (A2)", () => {
    ensureWpiPackageCopy(sourceDir, homeDir);
    const dest = wpiPackageDir(homeDir);
    fs.writeFileSync(path.join(dest, "extensions/sample/index.ts"), "// user edit\n");
    fs.writeFileSync(path.join(dest, "extra-file.txt"), "stale\n"); // file not in source

    writeSourceFile("extensions/sample/index.ts", "export const x = 2;\n"); // new wpi release
    const res = ensureWpiPackageCopy(sourceDir, homeDir);
    expect(res.action).toBe("upgraded");
    expect(res.differing).toContain("extensions/sample/index.ts");
    // Replaced with bundled source; stale file removed.
    expect(fs.readFileSync(path.join(dest, "extensions/sample/index.ts"), "utf-8")).toBe("export const x = 2;\n");
    expect(fs.existsSync(path.join(dest, "extra-file.txt"))).toBe(false);
  });
});

describe("compareWpiPackage", () => {
  it("is read-only and reports missing / in-sync / stale", () => {
    const dest = wpiPackageDir(homeDir);
    expect(compareWpiPackage(sourceDir, dest)).toEqual({ state: "missing" });

    ensureWpiPackageCopy(sourceDir, homeDir);
    expect(compareWpiPackage(sourceDir, dest)).toEqual({ state: "in-sync" });

    fs.writeFileSync(path.join(dest, "extensions/sample/index.ts"), "// drift\n");
    const res = compareWpiPackage(sourceDir, dest);
    expect(res.state).toBe("stale");
    if (res.state === "stale") expect(res.differing).toContain("extensions/sample/index.ts");
    // Never writes: the drifted copy survives inspection.
    expect(fs.readFileSync(path.join(dest, "extensions/sample/index.ts"), "utf-8")).toBe("// drift\n");
  });
});

describe("wireSettings", () => {
  const pkgPath = () => wpiPackageDir(homeDir);

  it("creates settings.json with our package when it does not exist", () => {
    const res = wireSettings(settingsPath, pkgPath());
    expect(res.action).toBe("added");
    expect(res.packagePath).toBe(path.resolve(pkgPath()));
    expect(readSettings().packages).toEqual([path.resolve(pkgPath())]);
  });

  it("preserves other keys and user packages; appends ours", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        packages: ["/some/user/package", "npm:user-pkg", { source: "git:github.com/user/repo" }],
      })
    );

    const res = wireSettings(settingsPath, pkgPath());
    expect(res.action).toBe("added");
    const s = readSettings();
    expect(s.theme).toBe("dark"); // untouched
    expect(s.packages).toEqual([
      "/some/user/package",
      "npm:user-pkg",
      { source: "git:github.com/user/repo" },
      path.resolve(pkgPath()),
    ]);
  });

  it("is a no-op when already wired (no duplicate, no write)", () => {
    wireSettings(settingsPath, pkgPath());
    const before = fs.statSync(settingsPath).mtimeMs;
    const res = wireSettings(settingsPath, pkgPath());
    expect(res.action).toBe("already");
    expect(readSettings().packages).toEqual([path.resolve(pkgPath())]);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before);
  });

  it("never removes existing entries — user packages are kept as-is", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ packages: ["/home/user/my-extensions", "git:github.com/someone/else"] })
    );

    const res = wireSettings(settingsPath, pkgPath());
    expect(res.action).toBe("added");
    const s = readSettings();
    expect(s.packages).toContain("/home/user/my-extensions"); // kept
    expect(s.packages).toContain("git:github.com/someone/else"); // kept
    expect(s.packages).toContain(path.resolve(pkgPath())); // ours appended
  });

  it("does not touch a settings file that exists but is malformed", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ not json !!");
    const res = wireSettings(settingsPath, pkgPath());
    expect(res.action).toBe("skipped-malformed");
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe("{ not json !!");
  });
});

describe("readNativeBinaries", () => {
  it("reads wpi.nativeBinaries from the package manifest", () => {
    expect(readNativeBinaries(sourceDir)).toEqual(["git"]);
  });

  it("returns [] when the manifest is missing or lacks the key", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-pkg-empty-"));
    try {
      expect(readNativeBinaries(empty)).toEqual([]);
      fs.writeFileSync(path.join(empty, "package.json"), JSON.stringify({ name: "x" }));
      expect(readNativeBinaries(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
