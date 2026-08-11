// ============================================================
// Tests for package-wiring.ts — host-mode package wiring (Phase 5)
// ============================================================
// Covers:
//   - ensureWpiPackageCopy: versioned copy, idempotent, collision-safe
//   - wireSettings: surgical merge — appends our path, preserves user
//     packages/keys, dedupes, replaces owned entries (other wpi-package
//     versions, stale docker-mode default), skips malformed settings
//   - readNativeBinaries: parses the wpi.nativeBinaries manifest
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ensureWpiPackageCopy,
  wireSettings,
  readNativeBinaries,
  wpiPackageDir,
  agentSettingsPath,
  isWpiPackageEntry,
  isStaleDockerDefault,
  DOCKER_DEFAULT_PACKAGE,
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
  it("versions the copy by wpi version", () => {
    expect(wpiPackageDir(homeDir, "1.0.0")).toBe(path.join(homeDir, ".pi", "wpi-package", "1.0.0"));
    expect(wpiPackageDir(homeDir, "2.0.0")).not.toBe(wpiPackageDir(homeDir, "1.0.0"));
  });

  it("points settings at ~/.pi/agent/settings.json", () => {
    expect(agentSettingsPath(path.join(homeDir, ".pi"))).toBe(path.join(homeDir, ".pi", "agent", "settings.json"));
  });
});

describe("ensureWpiPackageCopy", () => {
  it("copies the package to the versioned dir when absent", () => {
    const res = ensureWpiPackageCopy(sourceDir, homeDir, "1.0.0");
    expect(res.action).toBe("copied");
    expect(res.differing).toEqual([]);
    expect(fs.existsSync(path.join(res.path, "extensions/sample/index.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(res.path, "themes/github.json"), "utf-8")).toBe('{ "name": "github" }\n');
  });

  it("reports in-sync on an identical second call (idempotent)", () => {
    ensureWpiPackageCopy(sourceDir, homeDir, "1.0.0");
    const res = ensureWpiPackageCopy(sourceDir, homeDir, "1.0.0");
    expect(res.action).toBe("in-sync");
  });

  it("reports a collision and NEVER overwrites when the on-disk copy differs", () => {
    ensureWpiPackageCopy(sourceDir, homeDir, "1.0.0");
    const dest = wpiPackageDir(homeDir, "1.0.0");
    fs.writeFileSync(path.join(dest, "extensions/sample/index.ts"), "// user edit\n");

    const res = ensureWpiPackageCopy(sourceDir, homeDir, "1.0.0");
    expect(res.action).toBe("collision");
    expect(res.differing).toContain("extensions/sample/index.ts");
    // User edit survives — never overwritten.
    expect(fs.readFileSync(path.join(dest, "extensions/sample/index.ts"), "utf-8")).toBe("// user edit\n");
  });

  it("keeps versions isolated: a new version gets its own dir", () => {
    ensureWpiPackageCopy(sourceDir, homeDir, "1.0.0");
    writeSourceFile("extensions/sample/index.ts", "export const x = 2;\n"); // source changed for v2
    const res = ensureWpiPackageCopy(sourceDir, homeDir, "2.0.0");
    expect(res.action).toBe("copied");
    expect(fs.existsSync(wpiPackageDir(homeDir, "1.0.0"))).toBe(true); // v1 untouched
    expect(fs.readFileSync(path.join(res.path, "extensions/sample/index.ts"), "utf-8")).toContain("2");
  });
});

describe("wireSettings", () => {
  const pkgPath = () => wpiPackageDir(homeDir, "1.0.0");

  it("creates settings.json with our package when it does not exist", () => {
    const res = wireSettings(settingsPath, pkgPath(), homeDir);
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
        packages: ["npm:user-pkg", { source: "git:github.com/user/repo" }],
      })
    );

    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("added");
    const s = readSettings();
    expect(s.theme).toBe("dark"); // untouched
    expect(s.packages).toEqual(["npm:user-pkg", { source: "git:github.com/user/repo" }, path.resolve(pkgPath())]);
  });

  it("is a no-op when already wired (no duplicate, no write)", () => {
    wireSettings(settingsPath, pkgPath(), homeDir);
    const before = fs.statSync(settingsPath).mtimeMs;
    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("already");
    expect(readSettings().packages).toEqual([path.resolve(pkgPath())]);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(before);
  });

  it("replaces a wpi-owned entry of a different version (upgrade)", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        packages: [wpiPackageDir(homeDir, "0.9.0"), "npm:user-pkg"],
      })
    );

    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("replaced");
    expect(res.replacedFrom).toBe(wpiPackageDir(homeDir, "0.9.0"));
    const s = readSettings();
    expect(s.packages).toContain(path.resolve(pkgPath()));
    expect(s.packages).not.toContain(wpiPackageDir(homeDir, "0.9.0"));
    expect(s.packages).toContain("npm:user-pkg"); // user package kept
  });

  it("handles a relative entry that resolves inside wpi-package (owned)", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const relative = path.relative(path.dirname(settingsPath), wpiPackageDir(homeDir, "0.8.0"));
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [relative] }));

    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("replaced");
    expect(res.replacedFrom).toBe(wpiPackageDir(homeDir, "0.8.0"));
    expect(readSettings().packages).toEqual([path.resolve(pkgPath())]);
  });

  it("drops the stale docker-mode default (/opt/pi-package) when missing on host", () => {
    // Only exercised when /opt/pi-package is genuinely absent on the host;
    // otherwise the entry is a real path and must be kept (see next test).
    if (fs.existsSync(DOCKER_DEFAULT_PACKAGE)) return;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["../../../../opt/pi-package"] }));

    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("replaced");
    expect(res.replacedFrom).toBe(DOCKER_DEFAULT_PACKAGE);
    expect(readSettings().packages).toEqual([path.resolve(pkgPath())]);
  });

  it("keeps a docker-default entry when /opt/pi-package exists on the host", () => {
    if (!fs.existsSync(DOCKER_DEFAULT_PACKAGE)) return;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["../../../../opt/pi-package"] }));

    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("added");
    const s = readSettings();
    expect(s.packages).toContain("../../../../opt/pi-package"); // kept
    expect(s.packages).toContain(path.resolve(pkgPath())); // ours appended
  });

  it("does not touch a settings file that exists but is malformed", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ not json !!");
    const res = wireSettings(settingsPath, pkgPath(), homeDir);
    expect(res.action).toBe("skipped-malformed");
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe("{ not json !!");
  });
});

describe("isWpiPackageEntry / isStaleDockerDefault", () => {
  it("recognises owned wpi-package paths only", () => {
    expect(isWpiPackageEntry(wpiPackageDir(homeDir, "1.0.0"), homeDir)).toBe(true);
    expect(isWpiPackageEntry("/opt/pi-package", homeDir)).toBe(false);
    expect(isWpiPackageEntry("/home/other/.pi/wpi-package/1.0.0", homeDir)).toBe(false);
  });

  it("treats the docker default as stale only when missing on the host", () => {
    expect(isStaleDockerDefault(DOCKER_DEFAULT_PACKAGE, () => false)).toBe(true);
    expect(isStaleDockerDefault(DOCKER_DEFAULT_PACKAGE, () => true)).toBe(false);
    expect(isStaleDockerDefault("/other", () => false)).toBe(false);
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
