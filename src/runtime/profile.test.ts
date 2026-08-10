// ============================================================
// Tests for nono profile generation (Phase 3, slice 1)
// ============================================================
// Covers:
//   - buildWpiProfile shape (extends nolabs-ai/pi, workdir read-write)
//   - serializeWpiProfile is deterministic (stable key order + newline)
//   - wpiProfilePath / nonoProfilesDir resolve under ~/.config/nono/profiles
//   - ensureWpiProfile writes if absent, never overwrites if present
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  buildWpiProfile,
  serializeWpiProfile,
  ensureWpiProfile,
  wpiProfilePath,
  nonoProfilesDir,
  WPI_PROFILE_NAME,
  WPI_PROFILE_EXTENDS,
} from "./profile";

let homeDir: string;

beforeEach(() => {
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-prof-home-")));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("buildWpiProfile", () => {
  it("extends the signed nolabs-ai/pi pack", () => {
    const p = buildWpiProfile("1.2.3");
    expect(p.extends).toBe(WPI_PROFILE_EXTENDS);
    expect(p.meta.name).toBe(WPI_PROFILE_NAME);
    expect(p.meta.version).toBe("1.2.3");
  });

  it("grants read-write workdir access (the launched workspace)", () => {
    expect(buildWpiProfile("1.0.0").workdir.access).toBe("read-write");
  });

  it("carries no host-specific paths (portable across machines)", () => {
    const json = serializeWpiProfile(buildWpiProfile("1.0.0"));
    expect(json).not.toContain(os.homedir());
    expect(json).not.toContain("/Users/");
  });
});

describe("serializeWpiProfile", () => {
  it("is deterministic — same input yields identical bytes", () => {
    const a = serializeWpiProfile(buildWpiProfile("1.0.0"));
    const b = serializeWpiProfile(buildWpiProfile("1.0.0"));
    expect(a).toBe(b);
  });

  it("ends with a trailing newline", () => {
    expect(serializeWpiProfile(buildWpiProfile("1.0.0")).endsWith("\n")).toBe(true);
  });

  it("different versions produce different serialisations", () => {
    expect(serializeWpiProfile(buildWpiProfile("1.0.0")))
      .not.toBe(serializeWpiProfile(buildWpiProfile("2.0.0")));
  });
});

describe("paths", () => {
  it("wpiProfilePath lives under ~/.config/nono/profiles/wpi.json", () => {
    expect(wpiProfilePath(homeDir)).toBe(path.join(nonoProfilesDir(homeDir), "wpi.json"));
    expect(wpiProfilePath(homeDir)).toContain(".config/nono/profiles");
  });
});

describe("ensureWpiProfile", () => {
  it("creates the profiles dir and writes the profile when absent", () => {
    const res = ensureWpiProfile(homeDir, "1.0.0");
    expect(res.written).toBe(true);
    expect(res.existed).toBe(false);
    expect(fs.existsSync(res.path)).toBe(true);
    const onDisk = fs.readFileSync(res.path, "utf-8");
    expect(onDisk).toBe(serializeWpiProfile(buildWpiProfile("1.0.0")));
  });

  it("does NOT overwrite an existing profile (never overwrite user state)", () => {
    const first = ensureWpiProfile(homeDir, "1.0.0");
    // Tamper with the file to simulate a user edit / drift.
    fs.writeFileSync(first.path, "{ \"meta\": { \"name\": \"wpi\" }, \"extends\": \"nolabs-ai/pi\" }\n");

    const second = ensureWpiProfile(homeDir, "2.0.0");
    expect(second.written).toBe(false);
    expect(second.existed).toBe(true);
    // Content is unchanged — not overwritten with the v2.0.0 canonical form.
    const onDisk = fs.readFileSync(second.path, "utf-8");
    expect(onDisk).toContain("\"name\": \"wpi\"");
    expect(onDisk).not.toContain("2.0.0");
  });

  it("is idempotent when the canonical profile already matches", () => {
    ensureWpiProfile(homeDir, "1.0.0");
    const second = ensureWpiProfile(homeDir, "1.0.0");
    expect(second.written).toBe(false);
    expect(second.existed).toBe(true);
  });
});