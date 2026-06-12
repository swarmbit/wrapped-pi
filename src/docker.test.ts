// ============================================================
// Tests for docker.ts — Docker operations
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { buildDockerRunArgs } from "./docker";
import { generateDockerfile, generateEntrypoint } from "./templates";
import { PiContainerConfig, PI_VERSION, PI_IMAGE } from "./config";

function makeConfig(overrides: Partial<PiContainerConfig> = {}): PiContainerConfig {
  return {
    piVersion: PI_VERSION,
    ports: [],
    env: {},
    mounts: [],
    ...overrides,
  };
}

// Runtime context needed by buildDockerRunArgs
interface FullConfig extends PiContainerConfig {
  configDir: string;
  containerDir: string;
  projectDir: string;
  workspaceDir: string;
  debug: boolean;
  /** Derived from piVersion — not user-configurable. */
  piImage: string;
}

function makeFullConfig(overrides: Partial<FullConfig> = {}): FullConfig {
  return {
    piVersion: PI_VERSION,
    piImage: PI_IMAGE,
    ports: [],
    env: {},
    mounts: [],
    configDir: "/home/user/.pi",
    containerDir: "",
    projectDir: "/project",
    workspaceDir: "/project",
    debug: false,
    ...overrides,
  };
}

describe("buildDockerRunArgs", () => {
  it("includes run and rm flags", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args[0]).toBe("run");
    expect(args[1]).toBe("--rm");
  });

  it("mounts projectDir as dynamic workspace dir", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe("/project:/project:cached");
  });

  it("mounts configDir as pi config", () => {
    const config = makeFullConfig({ configDir: "/home/user/.pi" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const volArgs = args.filter((_, i) => args[i - 1] === "-v");
    const containerHome = os.homedir();
    expect(volArgs).toContain(`/home/user/.pi:${containerHome}/.pi`);
  });

  it("sets working directory to workspace dir", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const wIdx = args.indexOf("-w");
    expect(wIdx).toBeGreaterThan(-1);
    expect(args[wIdx + 1]).toBe("/project");
  });

  it("uses dynamic workspace dir based on project basename", () => {
    const config = makeFullConfig({ projectDir: "/home/user/my-app", workspaceDir: "/my-app" });
    const args = buildDockerRunArgs(config, ["pi"]);

    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toBe("/home/user/my-app:/my-app:cached");

    const wIdx = args.indexOf("-w");
    expect(args[wIdx + 1]).toBe("/my-app");
  });

  it("passes HOST_UID, HOST_GID, WORKSPACE_DIR, and PI_HOST_HOME env vars", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const uidEntry = args.find((a) => a.startsWith("HOST_UID="));
    const gidEntry = args.find((a) => a.startsWith("HOST_GID="));
    const workspaceEntry = args.find((a) => a.startsWith("WORKSPACE_DIR="));
    const hostHomeEntry = args.find((a) => a.startsWith("PI_HOST_HOME="));
    expect(uidEntry).toBeDefined();
    expect(gidEntry).toBeDefined();
    expect(workspaceEntry).toBe("WORKSPACE_DIR=/project");
    expect(hostHomeEntry).toBeDefined();
    expect(hostHomeEntry).toBe(`PI_HOST_HOME=${os.homedir()}`);
  });

  it("passes env vars from config as -e flags", () => {
    const config = makeFullConfig({ env: { ANTHROPIC_API_KEY: "sk-test", PORT: "3000" } });
    const args = buildDockerRunArgs(config, ["pi"]);

    const envEntries = args.filter((_, i) => args[i - 1] === "-e" && _.includes("="));
    expect(envEntries).toContain("ANTHROPIC_API_KEY=sk-test");
    expect(envEntries).toContain("PORT=3000");
  });

  it("does not add env flags when no env configured", () => {
    const config = makeFullConfig({ env: {} });
    const args = buildDockerRunArgs(config, ["pi"]);

    const envEntries = args.filter((a) => a.startsWith("ANTHROPIC") || a.startsWith("PORT="));
    expect(envEntries).toHaveLength(0);
  });

  it("uses the PI_IMAGE constant by default", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).toContain(PI_IMAGE);
  });

  it("passes pi args as the command", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi", "-p", "Summarize"]);

    expect(args.slice(-3)).toEqual(["pi", "-p", "Summarize"]);
  });

  it("does not set --name (allows concurrent instances)", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("--name");
  });

  it("allocates TTY when stdin is a TTY", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const hasItFlag = args.includes("-it") || args.includes("-i");
    expect(hasItFlag).toBe(true);
  });

  it("adds port mappings with localhost binding", () => {
    const config = makeFullConfig({ ports: [{ host: 3000, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("127.0.0.1:3000:3000");
  });

  it("adds host:container port mappings", () => {
    const config = makeFullConfig({ ports: [{ host: 8080, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("127.0.0.1:8080:3000");
  });

  it("adds multiple port mappings", () => {
    const config = makeFullConfig({
      ports: [
        { host: 3000, container: 3000 },
        { host: 8080, container: 80 },
        { host: 6006, container: 6006 },
      ],
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === "-p") acc.push(i);
      return acc;
    }, []);
    expect(pIndices).toHaveLength(3);
    expect(args[pIndices[0] + 1]).toBe("127.0.0.1:3000:3000");
    expect(args[pIndices[1] + 1]).toBe("127.0.0.1:8080:80");
    expect(args[pIndices[2] + 1]).toBe("127.0.0.1:6006:6006");
  });

  it("does not add -p flags when no ports configured", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    expect(args).not.toContain("-p");
  });

  it("ports come before the image name", () => {
    const config = makeFullConfig({ ports: [{ host: 3000, container: 3000 }] });
    const args = buildDockerRunArgs(config, ["pi"]);

    const pIdx = args.indexOf("-p");
    const imageIdx = args.indexOf(config.piImage);
    expect(pIdx).toBeLessThan(imageIdx);
  });

  it("does not pass TEAM_PACKAGES (removed)", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const teamPackagesEntry = args.find((a) => a.startsWith("TEAM_PACKAGES="));
    expect(teamPackagesEntry).toBeUndefined();
  });

  it("mounts docker socket via custom mounts", () => {
    const config = makeFullConfig({
      mounts: [{ host: "/var/run/docker.sock", container: "/var/run/docker.sock" }],
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const socketVolume = volumeArgs.find((v) => v.endsWith(":/var/run/docker.sock"));
    expect(socketVolume).toBeDefined();
    expect(socketVolume).toBe("/var/run/docker.sock:/var/run/docker.sock");
  });

  it("mounts custom path with mode", () => {
    const config = makeFullConfig({
      mounts: [{ host: "/host/ssh", container: "/container/ssh", mode: "ro" }],
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const sshVolume = volumeArgs.find((v) => v.includes("/container/ssh"));
    expect(sshVolume).toBe("/host/ssh:/container/ssh:ro");
  });

  it("does not add mount flags when no mounts configured", () => {
    // The default mounts are the project and config dirs.
    // There should be exactly 2 volume mounts, no more.
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs).toHaveLength(2);
  });

  it("adds multiple custom mounts", () => {
    const config = makeFullConfig({
      mounts: [
        { host: "/host/a", container: "/container/a" },
        { host: "/host/b", container: "/container/b", mode: "ro" },
      ],
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    // 2 default mounts + 2 custom = 4
    expect(volumeArgs).toHaveLength(4);
    expect(volumeArgs).toContain("/host/a:/container/a");
    expect(volumeArgs).toContain("/host/b:/container/b:ro");
  });

  it("does not mount docker socket when mounts list does not include it", () => {
    const config = makeFullConfig();
    const args = buildDockerRunArgs(config, ["pi"]);

    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const socketVolume = volumeArgs.find((v) => v.includes("docker.sock"));
    expect(socketVolume).toBeUndefined();
  });

  it("passes GIT_USER_NAME and GIT_USER_EMAIL when configured", () => {
    const config = makeFullConfig({
      gitUserName: "Test User",
      gitUserEmail: "test@example.com",
    });
    const args = buildDockerRunArgs(config, ["pi"]);

    const envEntries = args.filter((_, i) => args[i - 1] === "-e" && _.includes("="));
    expect(envEntries).toContain("GIT_USER_NAME=Test User");
    expect(envEntries).toContain("GIT_USER_EMAIL=test@example.com");
  });

  it("does not pass GIT_USER_NAME or GIT_USER_EMAIL when not configured", () => {
    const config = makeFullConfig({ gitUserName: undefined, gitUserEmail: undefined });
    const args = buildDockerRunArgs(config, ["pi"]);

    const hasGitEnv = args.some((a) => a.startsWith("GIT_USER_"));
    expect(hasGitEnv).toBe(false);
  });

  it("expands ${home} in mount host path", () => {
    const config = makeFullConfig({
      mounts: [{ host: "${home}/.ssh", container: "/home/user/.ssh", mode: "ro" }],
    });
    const args = buildDockerRunArgs(config, ["pi"]);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const sshMount = volumeArgs.find((v) => v.includes(".ssh"));
    expect(sshMount).toBeDefined();
    expect(sshMount).not.toContain("${home}");
    expect(sshMount).toMatch(/^\/.*\.ssh:\/home\/user\/\.ssh:ro$/);
  });

  it("expands ~ in mount host path", () => {
    const config = makeFullConfig({
      mounts: [{ host: "~/.ssh", container: "/home/user/.ssh", mode: "ro" }],
    });
    const args = buildDockerRunArgs(config, ["pi"]);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const sshMount = volumeArgs.find((v) => v.includes(".ssh"));
    expect(sshMount).toBeDefined();
    expect(sshMount).not.toContain("~");
    expect(sshMount).toMatch(/^\/.*\.ssh:\/home\/user\/\.ssh:ro$/);
  });

  it("expands ${workspaceDir} in volume container path", () => {
    const config = makeFullConfig();
    const configWithVolume = makeFullConfig({
      volumes: [{ name: "my-node-modules", container: "${workspaceDir}/node_modules" }],
    });
    const args = buildDockerRunArgs(configWithVolume, ["pi"]);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const nmVolume = volumeArgs.find((v) => v.includes("node_modules"));
    expect(nmVolume).toBeDefined();
    expect(nmVolume).toBe(`my-node-modules:/project/node_modules`);
  });

  it("expands ~ in mount container path", () => {
    const config = makeFullConfig({
      mounts: [{ host: "/host/ssh", container: "~/.ssh", mode: "ro" }],
    });
    const args = buildDockerRunArgs(config, ["pi"]);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    const sshMount = volumeArgs.find((v) => v.includes(".ssh"));
    expect(sshMount).toBeDefined();
    expect(sshMount).not.toContain("~");
  });
});

describe("build context", () => {
  it("creates a build context with Dockerfile and entrypoint", () => {
    const dockerfile = generateDockerfile();
    const entrypoint = generateEntrypoint();

    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS builder");
    expect(dockerfile).toContain(`ARG PI_VERSION=${PI_VERSION}`);
    expect(entrypoint).toContain("#!/usr/bin/env bash");
    expect(entrypoint).toContain('exec gosu "${USERNAME}" "$@"');
  });
});
