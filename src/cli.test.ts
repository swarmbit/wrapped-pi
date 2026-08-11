// ============================================================
// Tests for cli.ts — argument parsing and command dispatch
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";

const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

// Helper to run CLI with a temp home dir (avoids writing to real ~/.pi)
function runCli(args: string, options: { cwd: string; env?: Record<string, string> }): string {
  const piDir = path.join(options.cwd, ".pi");
  fs.mkdirSync(piDir, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...options.env,
    HOME: options.cwd,
  };
  return execSync(`node ${CLI_PATH} ${args}`, {
    encoding: "utf-8",
    cwd: options.cwd,
    env,
  });
}

describe("CLI", () => {
  it("prints help with --help", () => {
    const output = execSync(`node ${CLI_PATH} --help`, { encoding: "utf-8" });
    expect(output).toContain("wpi [command]");
    expect(output).toContain("build");
    expect(output).toContain("shell [id]");
    expect(output).toContain("dry-run");
  });

  it("prints version with --version", () => {
    const output = execSync(`node ${CLI_PATH} --version`, { encoding: "utf-8" });
    expect(output).toContain("wpi");
  });

  it("setup is a recognized command (host+none: unsandboxed warning → exit 1, never unknown-arg)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-setup-"));
    try {
      // Fast, deterministic pi stub on PATH (real pi startup can fetch model
      // catalogs over the network in fresh homes — flaky in tests).
      fs.mkdirSync(path.join(tmpDir, "bin"));
      fs.writeFileSync(path.join(tmpDir, "bin", "pi"), "#!/bin/sh\necho 'pi 0.84.1'\n");
      fs.chmodSync(path.join(tmpDir, "bin", "pi"), 0o755);
      const env = { ...process.env as Record<string, string>, HOME: tmpDir, PATH: `${path.join(tmpDir, "bin")}:${process.env.PATH}` };
      const output = execSync(`node ${CLI_PATH} setup --mode host --sandbox none`, {
        encoding: "utf-8",
        cwd: tmpDir,
        env,
        timeout: 20_000,
      });
      // host+none always warns (unsandboxed) → exit 1.
      expect(output).toContain("wpi setup — runtime mode: host");
      expect(output).toContain("unsandboxed");
    } catch (e: any) {
      // execSync throws on non-zero exit — setup exits 1 (warn); the report
      // must still be on stdout and never an unknown-argument error.
      const output = e.stdout || e.stderr || e.message || "";
      expect(output).toContain("wpi setup — runtime mode: host");
      expect(output).not.toContain("Unknown argument");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prints help with -h", () => {
    const output = execSync(`node ${CLI_PATH} -h`, { encoding: "utf-8" });
    expect(output).toContain("wpi [command]");
  });

  it("exits with error for unknown arguments", () => {
    try {
      execSync(`node ${CLI_PATH} --bogus 2>&1`, { encoding: "utf-8" });
      expect.fail("Should have exited with error");
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      expect(e.stderr || e.stdout || e.message).toContain("Unknown argument");
    }
  });

  it("separates pi args after --", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
    const output = runCli("dry-run -- -p \"test\"", { cwd: tmpDir });
    expect(output).toContain("pi");
    expect(output).toContain("test");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts shell with container id (fails gracefully when container not found)", () => {
    try {
      execSync(`node ${CLI_PATH} shell nonexistent-container 2>&1`, { encoding: "utf-8" });
      expect.fail("Should have exited with error");
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      const output = e.stderr || e.stdout || e.message || "";
      expect(output).toContain("not found");
    }
  });

  it("does not treat container id after shell as unknown argument", () => {
    try {
      execSync(`node ${CLI_PATH} shell my-container 2>&1`, { encoding: "utf-8" });
    } catch (e: any) {
      const output = e.stderr || e.stdout || e.message || "";
      // Should fail with "not found", not "Unknown argument"
      expect(output).not.toContain("Unknown argument");
    }
  });
});

describe("CLI dry-run", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows configuration with no .pi", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("version:");
    expect(output).toContain("image:");
  });

  it("detects .pi directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"));
    const output = runCli("dry-run", { cwd: tmpDir });
    expect(output).toContain(".pi");
  });

  it("shows docker run command with correct volume mounts", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    const basename = path.basename(tmpDir);
    expect(output).toContain(`/${basename}:cached`);
    // The config dir is mounted into the container under the host home dir (passed via HOME)
    // e.g., /tmp/.../.pi:/tmp/.../.pi
    expect(output).toContain(`/.pi:${tmpDir}/.pi`);
  });

  it("shows config sources in dry-run output", () => {
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("Config sources:");
    expect(output).toContain("User config:");
    expect(output).toContain("not found");
    expect(output).toContain("Project config:");
  });

  it("shows env from wpi.yml", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "wpi.yml"),
      "docker:\n  env:\n    ANTHROPIC_API_KEY: sk-test"
    );
    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("ANTHROPIC_API_KEY");
    expect(output).toContain("sk-test");
  });

  it("shows mounts in dry-run", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "wpi.yml"),
      "docker:\n  mounts:\n    - /var/run/docker.sock:/var/run/docker.sock\n    - /host/ssh:/container/ssh:ro"
    );
    const output = runCli("dry-run", { cwd: tmpDir });
    expect(output).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(output).toContain("/host/ssh:/container/ssh:ro");
  });

  it("shows empty mounts in dry-run", () => {
    const output = runCli("dry-run", { cwd: tmpDir });
    expect(output).toContain("mounts:");
    expect(output).toContain("(none)");
  });

  it("shows ports from wpi.yml", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "wpi.yml"),
      "docker:\n  ports:\n    - 3000\n    - 8080:80"
    );

    const output = runCli("dry-run", { cwd: tmpDir });

    expect(output).toContain("3000");
    expect(output).toContain("8080:80");
  });
});

// `wpi doctor` is exercised end-to-end through the real CLI binary here.
// The exact exit code depends on whether the Docker daemon is reachable on
// the host running the tests, so we assert on stable output shape rather than
// the exit code.
describe("CLI doctor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the four sections and a Summary line", () => {
    // doctor never exits 0 here unless docker is fully healthy AND no warnings;
    // swallow the exit code and inspect stdout+stderr regardless.
    let output = "";
    try {
      output = runCli("doctor", { cwd: tmpDir });
    } catch (e: any) {
      output = (e.stdout || "") + (e.stderr || "");
    }
    expect(output).toContain("wpi doctor — runtime mode: docker");
    expect(output).toContain("Runtime");
    expect(output).toContain("Sandbox");
    expect(output).toContain("Pi");
    expect(output).toContain("Docker");
    expect(output).toContain("Configuration");
    expect(output).toContain("Summary:");
  });

  it("warns on secret-looking env values", () => {
    const containerDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(
      path.join(containerDir, "wpi.yml"),
      "docker:\n  env:\n    ANTHROPIC_API_KEY: sk-test\n    FOO: bar"
    );

    let output = "";
    try {
      output = runCli("doctor", { cwd: tmpDir });
    } catch (e: any) {
      output = (e.stdout || "") + (e.stderr || "");
    }
    expect(output).toContain("env ANTHROPIC_API_KEY");
    expect(output).toMatch(/credential routes/);
    // FOO is not secret-looking — must not be flagged.
    expect(output).not.toContain("env FOO");
  });
});
