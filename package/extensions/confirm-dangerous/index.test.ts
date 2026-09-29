// ============================================================
// Tests for confirm-dangerous extension
// ============================================================
// Tests the exported helper functions and pattern matching logic.
// Read operations are verified to never be considered dangerous.
//
// The pi-coding-agent module is mocked since it's only available
// at runtime inside the pi agent, not in this test environment.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Clear env var so the default /workspace is used in tests.
// In production this is set by wpi, but tests need the default.
vi.hoisted(() => {
  const orig = process.env.WORKSPACE_DIR;
  delete process.env.WORKSPACE_DIR;
  return { orig };
});

// Mock @earendil-works/pi-coding-agent before importing the extension
vi.mock("@earendil-works/pi-coding-agent", () => ({
  isToolCallEventType: vi.fn((toolName: string, event: any) => {
    // Minimal mock: match based on event.toolName
    return event?.toolName === toolName;
  }),
  default: {},
}));

import confirmDangerous, {
  isOutsideWorkspace,
  isPiConfigDir,
  isTmpPath,
  isAllowedPath,
  isTmpRmCommand,
  isSafeRmCommand,
  DANGEROUS_PATTERNS,
  WORKSPACE_DIR,
} from "./index";

// ── isOutsideWorkspace ──────────────────────────────────────

describe("isOutsideWorkspace", () => {
  it("allows paths inside workspace (default /workspace)", () => {
    expect(isOutsideWorkspace("/workspace/src/index.ts")).toBe(false);
    expect(isOutsideWorkspace("/workspace/.env")).toBe(false);
    expect(isOutsideWorkspace("/workspace/deep/nested/path.txt")).toBe(false);
  });

  it("allows /workspace itself (default)", () => {
    expect(isOutsideWorkspace("/workspace")).toBe(false);
  });

  it("allows relative paths (resolved to /workspace by default)", () => {
    expect(isOutsideWorkspace("src/index.ts")).toBe(false);
    expect(isOutsideWorkspace(".env")).toBe(false);
    expect(isOutsideWorkspace("deep/nested/path.txt")).toBe(false);
  });

  it("blocks paths outside /workspace (default)", () => {
    expect(isOutsideWorkspace("/etc/passwd")).toBe(true);
    expect(isOutsideWorkspace("/usr/bin/node")).toBe(true);
    expect(isOutsideWorkspace("/root/.ssh/id_rsa")).toBe(true);
    expect(isOutsideWorkspace("/home/pi-user/.bashrc")).toBe(true);
  });

  it("blocks paths that start with /workspace but aren't under it", () => {
    expect(isOutsideWorkspace("/workspace-other/file")).toBe(true);
    expect(isOutsideWorkspace("/workspace2/file")).toBe(true);
  });

  it("respects custom workspace directory", () => {
    expect(isOutsideWorkspace("/myproject/src/index.ts", "/myproject")).toBe(false);
    expect(isOutsideWorkspace("/myproject", "/myproject")).toBe(false);
    expect(isOutsideWorkspace("/etc/passwd", "/myproject")).toBe(true);
    expect(isOutsideWorkspace("/workspace/file", "/myproject")).toBe(true);
    expect(isOutsideWorkspace("src/index.ts", "/myproject")).toBe(false);
  });
});

// ── isPiConfigDir ────────────────────────────────────────────

describe("isPiConfigDir", () => {
  it("allows paths inside the pi config directory", () => {
    expect(isPiConfigDir("/home/pi-user/.pi/agent/settings.json")).toBe(true);
    expect(isPiConfigDir("/home/pi-user/.pi/agent/extensions")).toBe(true);
    expect(isPiConfigDir("/home/pi-user/.pi/agent/sessions/abc.jsonl")).toBe(true);
    expect(isPiConfigDir("/home/pi-user/.pi/agent/auth.json")).toBe(true);
  });

  it("allows paths under /home/pi-user/.pi/ (full mount point)", () => {
    expect(isPiConfigDir("/home/pi-user/.pi/agent")).toBe(true);
    expect(isPiConfigDir("/home/pi-user/.pi/wpi.yml")).toBe(true);
    expect(isPiConfigDir("/home/pi-user/.pi/agent/extensions/my-ext/index.ts")).toBe(true);
  });

  it("blocks paths outside the pi config directory", () => {
    expect(isPiConfigDir("/etc/passwd")).toBe(false);
    expect(isPiConfigDir("/workspace/.env")).toBe(false);
    expect(isPiConfigDir("/home/pi-user/.bashrc")).toBe(false);
    expect(isPiConfigDir("/home/pi-user/.ssh/config")).toBe(false);
  });
});

// ── isTmpPath ────────────────────────────────────────────────

describe("isTmpPath", () => {
  it("allows /tmp itself", () => {
    expect(isTmpPath("/tmp")).toBe(true);
  });

  it("allows paths under /tmp", () => {
    expect(isTmpPath("/tmp/somefile")).toBe(true);
    expect(isTmpPath("/tmp/dir/file.txt")).toBe(true);
    expect(isTmpPath("/tmp/build-output.log")).toBe(true);
  });

  it("resolves relative paths — does not match non-absolute paths", () => {
    // Relative paths like tmp/file should NOT be treated as /tmp paths
    expect(isTmpPath("tmp/file")).toBe(false);
    expect(isTmpPath("/tmp/file")).toBe(true); // absolute works
  });

  it("blocks paths outside /tmp", () => {
    expect(isTmpPath("/etc/passwd")).toBe(false);
    expect(isTmpPath("/var/log")).toBe(false);
    expect(isTmpPath("/workspace/file")).toBe(false);
    expect(isTmpPath("/home/pi-user/.pi/agent")).toBe(false);
  });

  it("does not match /tmp-like paths", () => {
    expect(isTmpPath("/tmp2/something")).toBe(false);
    expect(isTmpPath("/tmprotary")).toBe(false);
  });
});

// ── isAllowedPath ────────────────────────────────────────────

describe("isAllowedPath", () => {
  it("allows pi config dir paths", () => {
    expect(isAllowedPath("/home/pi-user/.pi/agent/settings.json")).toBe(true);
    expect(isAllowedPath("/home/pi-user/.pi/agent/extensions/my-ext")).toBe(true);
  });

  it("allows /tmp paths", () => {
    expect(isAllowedPath("/tmp/build.log")).toBe(true);
    expect(isAllowedPath("/tmp")).toBe(true);
  });

  it("blocks other paths outside workspace", () => {
    expect(isAllowedPath("/etc/passwd")).toBe(false);
    expect(isAllowedPath("/var/log/syslog")).toBe(false);
    expect(isAllowedPath("/usr/bin/node")).toBe(false);
  });
});

// ── isTmpRmCommand ─────────────────────────────────────────

describe("isTmpRmCommand", () => {
  it("allows rm of /tmp files", () => {
    expect(isTmpRmCommand("rm /tmp/somefile")).toBe(true);
  });

  it("allows rm -rf of /tmp directories", () => {
    expect(isTmpRmCommand("rm -rf /tmp/build")).toBe(true);
    expect(isTmpRmCommand("rm -fr /tmp/cache")).toBe(true);
  });

  it("allows rm --force of /tmp files", () => {
    expect(isTmpRmCommand("rm --force /tmp/somefile")).toBe(true);
  });

  it("allows rm -r of /tmp directories", () => {
    expect(isTmpRmCommand("rm -r /tmp/test-dir")).toBe(true);
  });

  it("allows rm of multiple /tmp paths", () => {
    expect(isTmpRmCommand("rm /tmp/a /tmp/b /tmp/c")).toBe(true);
  });

  it("rejects rm of paths outside /tmp", () => {
    expect(isTmpRmCommand("rm -rf /workspace/node_modules")).toBe(false);
    expect(isTmpRmCommand("rm /etc/hostname")).toBe(false);
    expect(isTmpRmCommand("rm -rf /var/log/app")).toBe(false);
  });

  it("rejects rm mixing /tmp and non-/tmp paths", () => {
    expect(isTmpRmCommand("rm -rf /tmp/build /workspace/dist")).toBe(false);
  });

  it("rejects compound commands even when rm targets /tmp", () => {
    expect(isTmpRmCommand("rm -rf /tmp/build && sudo true")).toBe(false);
    expect(isTmpRmCommand("rm -rf /tmp/build; rm -rf /etc")).toBe(false);
  });

  it("rejects non-rm dangerous commands", () => {
    // sudo rm targets /tmp but sudo is always dangerous
    expect(isTmpRmCommand("sudo rm -rf /tmp/build")).toBe(false);
    // dd is not an rm command
    expect(isTmpRmCommand("dd if=/dev/zero of=/tmp/disk")).toBe(false);
  });

  it("rejects rm with relative paths (can't determine if /tmp)", () => {
    expect(isTmpRmCommand("rm -rf build")).toBe(false);
    expect(isTmpRmCommand("rm -rf ./cache")).toBe(false);
  });
});

// ── Workspace and /tmp removal exemption ────────────────────

describe("isSafeRmCommand", () => {
  it("allows standalone removal of files inside the workspace", () => {
    for (const command of [
      "rm -rf dist",
      "rm -r ./build",
      "rm -f src/index.ts",
      "rm --force /workspace/cache",
      "rm --recursive /workspace/output",
      "rm -rf -- .cache",
      "rm -rf 'build output'",
      'rm -rf "build output"',
      "rm -rf build\\ output",
      "rm -rf dist/*",
      "rm -rf /workspace/.cache /tmp/build",
    ]) {
      expect(isSafeRmCommand(command), command).toBe(true);
    }
  });

  it("resolves relative paths from the actual bash cwd", () => {
    expect(isSafeRmCommand("rm -rf output", "/workspace", "/workspace/sub")).toBe(true);
    expect(isSafeRmCommand("rm -rf output", "/workspace", "/etc")).toBe(false);
  });

  it("requires confirmation for paths outside the workspace or its root", () => {
    for (const command of [
      "rm -rf /etc", "rm -rf ../other", "rm -rf /workspace/../etc",
      "rm -rf /workspace-other/cache", "rm -rf /workspace",
      "rm -rf .", "rm -rf /workspace/file /etc/file",
      "rm -rf /tmp/cache ../other",
    ]) {
      expect(isSafeRmCommand(command), command).toBe(false);
    }
  });

  it("rejects sudo, unsafe flags, shell expansion, and compound commands", () => {
    for (const command of [
      "sudo rm -rf /workspace/dist",
      "rm -rf --no-preserve-root /workspace/dist",
      "rm -rf /workspace/dist --no-preserve-root",
      "rm -rf $TARGET", "rm -rf ${TARGET}", "rm -rf $(echo dist)",
      "rm -rf ~/dist", "rm -rf /workspace/dir*/file",
      "rm -rf dist && sudo true", "rm -rf dist; rm -rf /etc",
      "rm -rf dist | cat", "rm -rf dist > /etc/log",
      "rm -rf dist\nrm -rf /etc",
      "rm -rf", "rm -rf --",
    ]) {
      expect(isSafeRmCommand(command), command).toBe(false);
    }
  });

  it("rejects paths through symlinked workspace directories", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "confirm-dangerous-"));
    try {
      symlinkSync("/etc", path.join(workspace, "link"));
      expect(isSafeRmCommand(`rm -rf ${workspace}/link/file`, workspace)).toBe(false);
      expect(isSafeRmCommand(`rm -rf ${workspace}/link/`, workspace)).toBe(false);
      expect(isSafeRmCommand(`rm -rf ${workspace}/link/.`, workspace)).toBe(false);
      expect(isSafeRmCommand(`rm -rf ${workspace}/link`, workspace)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ── WORKSPACE_DIR constant ──────────────────────────────────

describe("WORKSPACE_DIR", () => {
  it("defaults to /workspace when WORKSPACE_DIR env is not set", () => {
    expect(WORKSPACE_DIR).toBe("/workspace");
  });
});

// ── Read operations are never dangerous ───────────────────────

describe("read safety", () => {
  it("read commands are not matched by dangerous patterns", () => {
    const safeCommands = [
      "cat /etc/passwd",
      "ls -la /",
      "grep pattern /var/log/syslog",
      "head -n 10 /etc/hosts",
      "tail -f /var/log/app.log",
      "less /etc/nginx/nginx.conf",
      "wc -l /workspace/src/index.ts",
      "find /workspace -name '*.ts'",
      "du -sh /workspace",
      "file /workspace/src/index.ts",
      "stat /workspace/package.json",
      "readlink -f ./symlink",
      "which node",
      "ps aux",
      "top -b -n 1",
      "df -h",
      "free -m",
      "uname -a",
      "whoami",
      "env",
      "printenv",
      "git status",
      "git log --oneline",
      "git diff HEAD",
      // Reading from /tmp is also safe
      "cat /tmp/build.log",
      "ls /tmp",
    ];

    for (const cmd of safeCommands) {
      for (const { pattern, description } of DANGEROUS_PATTERNS) {
        expect(pattern.test(cmd), `${description} pattern matched safe command: ${cmd}`).toBe(false);
      }
    }
  });
});

// ── Dangerous bash patterns ──────────────────────────────────

describe("DANGEROUS_PATTERNS", () => {
  it("matches rm -rf", () => {
    expect(somePatternMatches("rm -rf /tmp/thing")).toBe(true);
    expect(somePatternMatches("rm -rf /workspace/node_modules")).toBe(true);
  });

  it("matches rm --force", () => {
    expect(somePatternMatches("rm --force /tmp/thing")).toBe(true);
  });

  it("matches recursive flags even after other options", () => {
    expect(somePatternMatches("rm -r /tmp/dir")).toBe(true);
    expect(somePatternMatches("rm -R /etc/dir")).toBe(true);
    expect(somePatternMatches("rm -v --recursive /etc/dir")).toBe(true);
  });

  it("matches force flags even after other options", () => {
    expect(somePatternMatches("rm -v -rf /etc/dir")).toBe(true);
    expect(somePatternMatches("rm -v --force /etc/dir")).toBe(true);
  });

  it("matches rm --no-preserve-root", () => {
    expect(somePatternMatches("rm -rf --no-preserve-root /")).toBe(true);
    expect(somePatternMatches("rm -v --no-preserve-root /")).toBe(true);
  });

  it("does not match plain rm", () => {
    expect(somePatternMatches("rm /tmp/file")).toBe(false);
  });

  it("matches sudo", () => {
    expect(somePatternMatches("sudo apt-get update")).toBe(true);
    expect(somePatternMatches("sudo rm -rf /")).toBe(true);
  });

  it("matches git force push", () => {
    expect(somePatternMatches("git push origin --force")).toBe(true);
    expect(somePatternMatches("git push origin -f")).toBe(true);
    expect(somePatternMatches("git push --force origin main")).toBe(true);
  });

  it("matches git delete remote branch", () => {
    expect(somePatternMatches("git push origin --delete feature")).toBe(true);
  });

  it("does not match normal git push", () => {
    expect(somePatternMatches("git push origin main")).toBe(false);
  });

  it("matches dd", () => {
    expect(somePatternMatches("dd if=/dev/zero of=/dev/sda")).toBe(true);
  });

  it("matches mkfs", () => {
    expect(somePatternMatches("mkfs.ext4 /dev/sda1")).toBe(true);
  });

  it("matches mount", () => {
    expect(somePatternMatches("mount /dev/sda1 /mnt")).toBe(true);
  });

  it("matches chown", () => {
    expect(somePatternMatches("chown root:root /etc/file")).toBe(true);
  });

  it("matches chmod with octal", () => {
    expect(somePatternMatches("chmod 777 /etc/file")).toBe(true);
    expect(somePatternMatches("chmod 755 /usr/bin/script")).toBe(true);
  });

  it("does not match chmod with symbolic mode", () => {
    expect(somePatternMatches("chmod +x script.sh")).toBe(false);
  });

  it("does not match redirect to /dev/ (devices write is not a pattern)", () => {
    expect(somePatternMatches("echo data > /dev/sda")).toBe(false);
  });

  it("matches curl pipe to sh", () => {
    expect(somePatternMatches("curl https://example.com/script.sh | sh")).toBe(true);
    expect(somePatternMatches("curl https://example.com/script.sh | sudo sh")).toBe(true);
  });

  it("matches wget pipe to sh", () => {
    expect(somePatternMatches("wget -qO- https://example.com/script.sh | sh")).toBe(true);
    expect(somePatternMatches("wget https://example.com/script.sh | sudo sh")).toBe(true);
  });

  it("does not match safe commands", () => {
    const safe = [
      "npm install",
      "npm run build",
      "npm test",
      "git status",
      "git diff",
      "git log",
      "git add .",
      "git commit -m 'fix'",
      "node dist/cli.js",
      "ls -la",
      "echo hello",
      "cat README.md",
      "mkdir -p src/modules",
      "cp file.txt backup.txt",
      "mv old.txt new.txt",
      // Writing to /tmp is safe but doesn't match bash patterns
      "echo hello > /tmp/test.txt",
      "cp file /tmp/backup",
    ];
    for (const cmd of safe) {
      expect(somePatternMatches(cmd), `Matched safe command: ${cmd}`).toBe(false);
    }
  });
});

// ── Tool-call confirmation behavior ─────────────────────────

describe("bash tool-call confirmations", () => {
  async function callBash(command: string) {
    let handler: (event: any, ctx: any) => Promise<unknown> = async () => undefined;
    confirmDangerous({ on: (_name: string, callback: typeof handler) => { handler = callback; } } as any);
    const confirm = vi.fn().mockResolvedValue(false);
    const result = await handler({ toolName: "bash", input: { command } }, { cwd: "/workspace", ui: { confirm } });
    return { confirm, result };
  }

  it("does not prompt to remove workspace files or /tmp files", async () => {
    for (const command of ["rm -rf dist", "rm -rf /workspace/dist", "rm -rf /tmp/cache"]) {
      const { confirm, result } = await callBash(command);
      expect(confirm, command).not.toHaveBeenCalled();
      expect(result, command).toBeUndefined();
    }
  });

  it("prompts before removing files outside the workspace or using other dangerous operations", async () => {
    for (const command of [
      "rm -rf /etc", "rm -rf ../outside", "rm -rf dist && sudo true",
      "sudo rm -rf dist", "rm -rf --no-preserve-root dist", "git push origin --force",
      "rm -v -rf /etc", "rm -R /etc", "rm --recursive /etc",
    ]) {
      const { confirm, result } = await callBash(command);
      expect(confirm, command).toHaveBeenCalledOnce();
      expect(result, command).toMatchObject({ block: true });
    }
  });
});

// ── Combined: write protection logic ─────────────

describe("write protection logic", () => {
  it("allows writes inside workspace", () => {
    expect(isOutsideWorkspace("/workspace/src/index.ts")).toBe(false);
  });

  it("allows writes to pi config dir even if outside workspace", () => {
    expect(isOutsideWorkspace("/home/pi-user/.pi/agent/settings.json")).toBe(true);
    expect(isAllowedPath("/home/pi-user/.pi/agent/settings.json")).toBe(true);
  });

  it("allows writes to /tmp even if outside workspace", () => {
    expect(isOutsideWorkspace("/tmp/build.log")).toBe(true);
    expect(isAllowedPath("/tmp/build.log")).toBe(true);
  });

  it("blocks writes that are outside workspace and not in allowed paths", () => {
    expect(isOutsideWorkspace("/etc/passwd")).toBe(true);
    expect(isAllowedPath("/etc/passwd")).toBe(false);
  });
});

// ── Helpers ───────────────────────────────────────────────────

function somePatternMatches(command: string): boolean {
  return DANGEROUS_PATTERNS.some(({ pattern }) => pattern.test(command));
}