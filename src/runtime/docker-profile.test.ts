// ============================================================
// Tests for docker-profile.ts — wpi-docker nono profile (Phase 4)
// ============================================================
// Covers:
//   - buildWpiDockerProfile: socket / ~/.pi / tmpdir / mount grants
//     (ro → filesystem.read, rw → filesystem.allow), extends default,
//     meta fields, custom profile name
//   - expandFsPath: ~ / $HOME / ${HOME} / $WORKDIR expansion
//   - serializeWpiDockerProfile determinism (sorted keys)
//   - ensureWpiDockerProfile: write-if-absent, in-sync, drift (never overwrite)
//   - checkProfileGrants: socket + mount coverage, drift-caused gaps
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DEFAULT_NONO_DOCKER_PROFILE, DEFAULT_DOCKER_SOCKET } from "../config";
import {
  buildWpiDockerProfile,
  serializeWpiDockerProfile,
  ensureWpiDockerProfile,
  checkProfileGrants,
  expandFsPath,
  wpiDockerProfilePath,
  WPI_DOCKER_PROFILE_NAME,
  WPI_DOCKER_PROFILE_EXTENDS,
  type DockerProfileInput,
} from "./docker-profile";

let homeDir: string;

function input(overrides: Partial<DockerProfileInput> = {}): DockerProfileInput {
  return {
    wpiVersion: "1.0.0",
    homeDir,
    dockerSocket: DEFAULT_DOCKER_SOCKET,
    mounts: [],
    ...overrides,
  };
}

beforeEach(() => {
  homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpi-docker-prof-home-")));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("buildWpiDockerProfile — shape", () => {
  it("extends the default profile (system binary read access)", () => {
    const p = buildWpiDockerProfile(input());
    expect(p.extends).toBe(WPI_DOCKER_PROFILE_EXTENDS);
    expect(p.meta.name).toBe(WPI_DOCKER_PROFILE_NAME);
    expect(p.meta.version).toBe("1.0.0");
    expect(p.meta.author).toBe("wpi");
  });

  it("uses the configured nono.dockerProfile name", () => {
    const p = buildWpiDockerProfile(input({ profileName: "my-docker-profile" }));
    expect(p.meta.name).toBe("my-docker-profile");
  });

  it("defaults to the wpi-docker constant", () => {
    expect(WPI_DOCKER_PROFILE_NAME).toBe(DEFAULT_NONO_DOCKER_PROFILE);
  });
});

describe("buildWpiDockerProfile — filesystem grants", () => {
  it("grants the daemon socket via unix_socket (connect)", () => {
    const p = buildWpiDockerProfile(input());
    expect(p.filesystem.unix_socket).toContain(DEFAULT_DOCKER_SOCKET);
  });

  it("uses the configured docker.socket path (expansion applied)", () => {
    const p = buildWpiDockerProfile(input({ dockerSocket: "unix:///tmp/docker.sock" }));
    // The config resolver strips unix://; but if a raw path arrives, expand it.
    expect(p.filesystem.unix_socket).toContain("/tmp/docker.sock");
  });

  it("grants ~/.pi (agent state) read-write", () => {
    const p = buildWpiDockerProfile(input());
    expect(p.filesystem.allow).toContain(path.join(homeDir, ".pi"));
  });

  it("grants the OS tmpdir (build context) read-write", () => {
    const p = buildWpiDockerProfile(input());
    expect(p.filesystem.allow).toContain(os.tmpdir());
  });

  it("maps ro mounts to filesystem.read and rw mounts to filesystem.allow", () => {
    const p = buildWpiDockerProfile(
      input({
        mounts: [
          { host: "~/.ssh", container: "/home/pi-user/.ssh", mode: "ro" },
          { host: "~/data", container: "/data", mode: "rw" },
          { host: "/opt/tool", container: "/opt/tool" }, // no mode → rw
        ],
      })
    );
    expect(p.filesystem.read).toContain(path.join(homeDir, ".ssh"));
    expect(p.filesystem.allow).toContain(path.join(homeDir, "data"));
    expect(p.filesystem.allow).toContain("/opt/tool");
    expect(p.filesystem.read).not.toContain(path.join(homeDir, "data"));
  });

  it("dedupes overlapping allow entries", () => {
    const p = buildWpiDockerProfile(
      input({ mounts: [{ host: "~/.pi", container: "/x", mode: "rw" }] })
    );
    const allows = p.filesystem.allow as string[];
    expect(allows.filter((x) => x === path.join(homeDir, ".pi"))).toHaveLength(1);
  });

  it("omits filesystem section keys that are empty", () => {
    const p = buildWpiDockerProfile(input({ dockerSocket: "", mounts: [] }));
    expect(p.filesystem.unix_socket).toBeUndefined();
    expect(p.filesystem.read).toBeUndefined();
    // ~/.pi + tmpdir remain — the client always needs them.
    expect(p.filesystem.allow.length).toBeGreaterThan(0);
  });
});

describe("expandFsPath", () => {
  it("expands ~ / $HOME / ${HOME} / $WORKDIR", () => {
    expect(expandFsPath("~/.ssh", homeDir)).toBe(path.join(homeDir, ".ssh"));
    expect(expandFsPath("$HOME/x", homeDir)).toBe(path.join(homeDir, "x"));
    expect(expandFsPath("${HOME}/x", homeDir)).toBe(path.join(homeDir, "x"));
    expect(expandFsPath("${WORKDIR}/sub", homeDir)).toBe(path.join(process.cwd(), "sub"));
  });
});

describe("serializeWpiDockerProfile — determinism", () => {
  it("is deterministic (sorted keys + trailing newline)", () => {
    const a = serializeWpiDockerProfile(buildWpiDockerProfile(input()));
    const b = serializeWpiDockerProfile(buildWpiDockerProfile(input()));
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("differs when config changes (drift source)", () => {
    const base = serializeWpiDockerProfile(buildWpiDockerProfile(input()));
    const withMount = serializeWpiDockerProfile(
      buildWpiDockerProfile(input({ mounts: [{ host: "/host/x", container: "/c", mode: "ro" }] }))
    );
    expect(base).not.toBe(withMount);
  });
});

describe("ensureWpiDockerProfile — write & drift", () => {
  it("writes the canonical profile when absent (write-if-absent)", () => {
    const res = ensureWpiDockerProfile(input());
    expect(res.written).toBe(true);
    expect(res.drifted).toBe(false);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(fs.readFileSync(res.path, "utf-8")).toBe(
      serializeWpiDockerProfile(buildWpiDockerProfile(input()))
    );
  });

  it("reports inSync on a matching on-disk profile", () => {
    ensureWpiDockerProfile(input());
    const res = ensureWpiDockerProfile(input());
    expect(res.written).toBe(false);
    expect(res.inSync).toBe(true);
    expect(res.drifted).toBe(false);
  });

  it("reports drift and NEVER overwrites a differing profile", () => {
    const first = ensureWpiDockerProfile(input());
    fs.writeFileSync(first.path, '{ "meta": { "name": "wpi-docker" } }\n');

    const res = ensureWpiDockerProfile(input());
    expect(res.written).toBe(false);
    expect(res.drifted).toBe(true);
    expect(res.inSync).toBe(false);
    expect(fs.readFileSync(res.path, "utf-8")).toBe('{ "meta": { "name": "wpi-docker" } }\n');
  });

  it("uses a custom profile name for both path and content", () => {
    const res = ensureWpiDockerProfile(input({ profileName: "team-docker" }));
    expect(res.path).toBe(wpiDockerProfilePath(homeDir, "team-docker"));
    expect(res.path.endsWith("team-docker.json")).toBe(true);
    expect(JSON.parse(fs.readFileSync(res.path, "utf-8")).meta.name).toBe("team-docker");
  });
});

describe("checkProfileGrants — socket + mounts", () => {
  it("grants the socket and declared mounts in the canonical profile", () => {
    const cfg = input({
      mounts: [
        { host: "~/.ssh", container: "/c", mode: "ro" },
        { host: "/opt/tool", container: "/c", mode: "rw" },
      ],
    });
    const checks = checkProfileGrants(cfg, buildWpiDockerProfile(cfg));
    const socket = checks.find((c) => c.kind === "socket")!;
    expect(socket.path).toBe(DEFAULT_DOCKER_SOCKET);
    expect(socket.granted).toBe(true);
    for (const m of checks.filter((c) => c.kind === "mount")) {
      expect(m.granted).toBe(true);
    }
  });

  it("flags mounts missing from a drifted on-disk profile", () => {
    const cfg = input({ mounts: [{ host: "/host/data", container: "/c", mode: "rw" }] });
    const drifted = { extends: "default", filesystem: { unix_socket: [DEFAULT_DOCKER_SOCKET] } };
    const checks = checkProfileGrants(cfg, drifted);
    const mount = checks.find((c) => c.kind === "mount")!;
    expect(mount.path).toBe("/host/data");
    expect(mount.granted).toBe(false);
    expect(checks.find((c) => c.kind === "socket")!.granted).toBe(true);
  });

  it("flags a socket grant missing from a drifted profile (socket path changed)", () => {
    const cfg = input({ dockerSocket: "/var/run/docker.sock" });
    const drifted = { extends: "default", filesystem: { unix_socket: ["/tmp/other.sock"] } };
    const checks = checkProfileGrants(cfg, drifted);
    expect(checks.find((c) => c.kind === "socket")!.granted).toBe(false);
  });
});
