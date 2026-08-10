// ============================================================
// Tests for nono profile generation (Phase 3, commit 2)
// ============================================================
// Covers:
//   - buildWpiProfile shape (extends nolabs-ai/pi, workdir read-write)
//   - serializeWpiProfile is deterministic (sorted keys + newline)
//   - filesystem.allow/read from workspace + nono fs grants (with expansion)
//   - network: allow_domain from allowDomains; credentials; custom_credentials
//   - environment.deny_vars from credential routes (route wins)
//   - path expansion (~ / $HOME / $WORKDIR) — no literal placeholders remain
//   - ensureWpiProfile: write-if-absent; never-overwrite; drift detection
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
  expandFsPath,
  credentialEnvVarNames,
  type ProfileInput,
} from "./profile";
import { EMPTY_NETWORK, EMPTY_NONO, type NetworkConfig, type NonoConfig } from "../config";

let homeDir: string;

function input(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    wpiVersion: "1.0.0",
    homeDir,
    workspaceDir: "/home/user/proj",
    network: EMPTY_NETWORK,
    workspace: EMPTY_NONO,
    nono: EMPTY_NONO,
    deniedEnvVars: [],
    ...overrides,
  };
}

beforeEach(() => {
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-prof-home-")));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("buildWpiProfile — shape", () => {
  it("extends the signed nolabs-ai/pi pack", () => {
    const p = buildWpiProfile(input());
    expect(p.extends).toBe(WPI_PROFILE_EXTENDS);
    expect(p.meta.name).toBe(WPI_PROFILE_NAME);
    expect(p.meta.version).toBe("1.0.0");
  });

  it("grants readwrite workdir access", () => {
    expect(buildWpiProfile(input()).workdir.access).toBe("readwrite");
  });

  it("emits no filesystem/network/environment when config is empty", () => {
    const p = buildWpiProfile(input());
    expect(p.filesystem).toBeUndefined();
    expect(p.network).toBeUndefined();
    expect(p.environment).toBeUndefined();
  });
});

describe("buildWpiProfile — filesystem grants", () => {
  it("merges workspace + nono allowPaths into filesystem.allow (dedup)", () => {
    const p = buildWpiProfile(
      input({
        workspace: { allowPaths: ["~/src", "~/.config"], readPaths: [] },
        nono: { allowPaths: ["~/.config", "/tmp/x"], readPaths: [] },
      })
    );
    expect(p.filesystem.allow).toContain("/tmp/x");
    expect(p.filesystem.allow).not.toContain("~/src");
    expect(p.filesystem.allow).toContain(path.join(homeDir, "src"));
    // deduped (~/.config appears once)
    const cfg = p.filesystem.allow as string[];
    expect(cfg.filter((x: string) => x === path.join(homeDir, ".config"))).toHaveLength(1);
  });

  it("expands ~ / $HOME / $WORKDIR (no placeholders remain)", () => {
    const p = buildWpiProfile(
      input({
        workspace: { allowPaths: ["${WORKDIR}/sub", "~/.ssh"], readPaths: ["$HOME/secrets"] },
        nono: { allowPaths: [], readPaths: [] },
      })
    );
    const all = [...(p.filesystem.allow ?? []), ...(p.filesystem.read ?? [])] as string[];
    expect(all.every((s) => !s.includes("$"))).toBe(true);
    expect(all.every((s) => !s.startsWith("~"))).toBe(true);
  });

  it("emits filesystem.read for read-only grants", () => {
    const p = buildWpiProfile(
      input({ workspace: { allowPaths: [], readPaths: ["/etc"] } })
    );
    expect(p.filesystem.read).toContain("/etc");
    expect(p.filesystem.allow).toBeUndefined();
  });
});

describe("buildWpiProfile — network", () => {
  it("maps allowDomains → network.allow_domain", () => {
    const network: NetworkConfig = { ...EMPTY_NETWORK, allowDomains: ["api.anthropic.com", "github.com"] };
    const p = buildWpiProfile(input({ network }));
    expect(p.network.allow_domain).toEqual(["api.anthropic.com", "github.com"]);
  });

  it("maps credentials → network.credentials (presets)", () => {
    const network: NetworkConfig = { ...EMPTY_NETWORK, credentials: ["anthropic", "github"] };
    const p = buildWpiProfile(input({ network }));
    expect(p.network.credentials).toEqual(["anthropic", "github"]);
  });

  it("maps customCredentials → network.custom_credentials (snake_case fields)", () => {
    const network: NetworkConfig = {
      ...EMPTY_NETWORK,
      customCredentials: {
        firecrawl: {
          upstream: "https://api.firecrawl.dev",
          credentialKey: "firecrawl_api_key",
          envVar: "FIRECRAWL_API_KEY",
          injectHeader: "Authorization",
          credentialFormat: "Bearer {}",
        },
      },
    };
    const p = buildWpiProfile(input({ network }));
    expect(p.network.custom_credentials.firecrawl).toMatchObject({
      upstream: "https://api.firecrawl.dev",
      credential_key: "firecrawl_api_key",
      env_var: "FIRECRAWL_API_KEY",
      inject_header: "Authorization",
      credential_format: "Bearer {}",
    });
  });

  it("emits network.block = true when mode is blocked", () => {
    const network: NetworkConfig = { ...EMPTY_NETWORK, mode: "blocked" };
    expect(buildWpiProfile(input({ network })).network.block).toBe(true);
  });

  it("omits network_profile (wpi allow_domain is authoritative)", () => {
    const network: NetworkConfig = { ...EMPTY_NETWORK, allowDomains: ["api.anthropic.com"] };
    expect(buildWpiProfile(input({ network })).network.network_profile).toBeUndefined();
  });
});

describe("buildWpiProfile — route wins (deny_vars)", () => {
  it("populates environment.deny_vars from preset + custom credential env vars", () => {
    const network: NetworkConfig = {
      ...EMPTY_NETWORK,
      credentials: ["anthropic", "github"],
      customCredentials: {
        firecrawl: { upstream: "https://api.firecrawl.dev", envVar: "FIRECRAWL_API_KEY" },
      },
    };
    const p = buildWpiProfile(input({ network, deniedEnvVars: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "FIRECRAWL_API_KEY"] }));
    expect(p.environment.deny_vars).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "FIRECRAWL_API_KEY"])
    );
  });
});

describe("credentialEnvVarNames", () => {
  it("maps preset services to their env var names", () => {
    expect(credentialEnvVarNames(["anthropic", "github"])).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"])
    );
  });
  it("includes custom credential env vars", () => {
    expect(
      credentialEnvVarNames([], { firecrawl: { upstream: "https://x", envVar: "FIRECRAWL_API_KEY" } })
    ).toEqual(["FIRECRAWL_API_KEY"]);
  });
});

describe("serializeWpiProfile — determinism", () => {
  it("is deterministic (sorted keys + trailing newline)", () => {
    const a = serializeWpiProfile(buildWpiProfile(input()));
    const b = serializeWpiProfile(buildWpiProfile(input()));
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });
  it("different config yields different serialisation", () => {
    const base = serializeWpiProfile(buildWpiProfile(input()));
    const withNet = serializeWpiProfile(
      buildWpiProfile(input({ network: { ...EMPTY_NETWORK, allowDomains: ["x.com"] } }))
    );
    expect(base).not.toBe(withNet);
  });
});

describe("paths", () => {
  it("lives under ~/.config/nono/profiles/wpi.json", () => {
    expect(wpiProfilePath(homeDir)).toBe(path.join(nonoProfilesDir(homeDir), "wpi.json"));
    expect(wpiProfilePath(homeDir)).toContain(".config/nono/profiles");
  });
});

describe("ensureWpiProfile — write & drift", () => {
  it("writes the canonical profile when absent", () => {
    const res = ensureWpiProfile(input());
    expect(res.written).toBe(true);
    expect(res.drifted).toBe(false);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(fs.readFileSync(res.path, "utf-8")).toBe(
      serializeWpiProfile(buildWpiProfile(input()))
    );
  });

  it("reports inSync when the on-disk profile matches canonical", () => {
    ensureWpiProfile(input());
    const res = ensureWpiProfile(input());
    expect(res.written).toBe(false);
    expect(res.inSync).toBe(true);
    expect(res.drifted).toBe(false);
  });

  it("reports drift and NEVER overwrites when the profile differs", () => {
    const first = ensureWpiProfile(input());
    // Simulate a user edit / stale profile.
    fs.writeFileSync(first.path, "{ \"meta\": { \"name\": \"wpi\" } }\n");

    const res = ensureWpiProfile(input());
    expect(res.written).toBe(false);
    expect(res.drifted).toBe(true);
    expect(res.inSync).toBe(false);
    // Content unchanged — not regenerated
    expect(fs.readFileSync(res.path, "utf-8")).toBe("{ \"meta\": { \"name\": \"wpi\" } }\n");
  });

  it("reports drift when config changed and on-disk is stale", () => {
    ensureWpiProfile(input());
    // New canonical with an allow domain → differs from on-disk
    const res = ensureWpiProfile(
      input({ network: { ...EMPTY_NETWORK, allowDomains: ["api.anthropic.com"] } })
    );
    expect(res.drifted).toBe(true);
    expect(fs.readFileSync(res.path, "utf-8")).not.toContain("api.anthropic.com");
  });
});