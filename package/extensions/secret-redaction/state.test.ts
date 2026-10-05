import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSecretStorage, SessionSecrets } from "./state";
import { SecretRedactor } from "./redactor";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-secrets-test-")); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

function redactor(session = "session-a") { return new SecretRedactor(new FileSecretStorage(tmp, session)); }

describe("local mapping storage", () => {
  it("survives reloads and resumes with stable placeholders and restrictive permissions", () => {
    const first = redactor();
    const token = first.registerSecret("sample-secret-12345");
    expect(redactor().registerSecret("sample-secret-12345")).toBe(token);
    expect(redactor().restore(token)).toBe("sample-secret-12345");
    const scope = fs.readdirSync(tmp)[0];
    const file = fs.readdirSync(path.join(tmp, scope))[0];
    expect(fs.statSync(path.join(tmp, scope)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(tmp, scope, file)).mode & 0o777).toBe(0o600);
  });

  it("resolves parent/child and forked-session placeholders without sharing raw prompts", () => {
    const parent = redactor("parent");
    const child = redactor("child");
    const parentToken = parent.registerSecret("parent-test-secret");
    expect(child.redact(`Use ${parentToken}`)).toBe(`Use ${parentToken}`);
    expect(child.restore(parentToken)).toBe("parent-test-secret");
    const childToken = child.registerSecret("child-test-secret");
    expect(parent.restore(childToken)).toBe("child-test-secret");
  });

  it("does not lose mappings from independent writers", () => {
    const a = redactor();
    const b = redactor();
    const tokenA = a.registerSecret("first-test-secret");
    const tokenB = b.registerSecret("second-test-secret");
    const reloaded = redactor();
    expect(reloaded.restore([tokenA, tokenB])).toEqual(["first-test-secret", "second-test-secret"]);
    expect(reloaded.size).toBe(2);
  });

  it("remembers across reloads which values are masked only where they are assigned", () => {
    const first = redactor();
    const masked = first.redact("const token = accessToken;");
    expect(masked).not.toContain("accessToken");
    // A new process, or a child agent, loading the same records.
    const reloaded = redactor();
    expect(reloaded.redact("refresh(accessToken);")).toBe("refresh(accessToken);");
    expect(reloaded.restore(masked)).toBe("const token = accessToken;");
    expect(redactor("child").restore(masked)).toBe("const token = accessToken;");
    // Once confirmed as a credential it stays one, whichever record loads first.
    reloaded.discover({ token: "accessToken" });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(redactor().redact("refresh(accessToken);")).not.toContain("accessToken");
    }
  });

  it("reports missing and corrupt mappings without exposing file contents", () => {
    const first = redactor();
    const token = first.registerSecret("do-not-print-this-value");
    const scope = fs.readdirSync(tmp)[0];
    const file = path.join(tmp, scope, fs.readdirSync(path.join(tmp, scope))[0]);
    fs.writeFileSync(file, "invalid JSON do-not-print-this-value");
    expect(() => redactor()).toThrow("Cannot read the local secret mapping");
    fs.rmSync(file);
    expect(() => redactor().restore(token)).toThrow("Unknown secret placeholder");
  });
});

describe("automatic discovery", () => {
  it("seeds dotenv, environment, Pi auth, models, and wpi config without changing sources", () => {
    const agentDir = path.join(tmp, "agent");
    fs.mkdirSync(agentDir);
    const envText = 'PORT=3000\nDB_PASSWORD="dotenv-test-password"\n';
    fs.writeFileSync(path.join(tmp, ".env.local"), envText);
    fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
      example: { type: "oauth", access: "oauth-test-access", refresh: "oauth-test-refresh" },
      api: { type: "api_key", key: "auth-test-api-key" },
      command: { type: "api_key", key: `!touch ${path.join(tmp, "must-not-exist")}` },
    }));
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ apiKey: "model-test-api-key" }));
    fs.writeFileSync(path.join(tmp, "wpi.yml"), "docker:\n  env:\n    PRIVATE_TOKEN: wpi-test-secret\n");
    vi.stubEnv("SAMPLE_API_KEY", "environment-test-secret");
    const session = new SessionSecrets(agentDir, "seed-test");
    session.refresh(tmp);
    for (const secret of ["dotenv-test-password", "oauth-test-access", "oauth-test-refresh", "auth-test-api-key", "model-test-api-key", "wpi-test-secret", "environment-test-secret"]) {
      expect(session.redactor.redact(`unlabeled ${secret}`)).not.toContain(secret);
    }
    expect(fs.readFileSync(path.join(tmp, ".env.local"), "utf8")).toBe(envText);
    expect(process.env.SAMPLE_API_KEY).toBe("environment-test-secret");
    expect(fs.existsSync(path.join(tmp, "must-not-exist"))).toBe(false);
  });

  it("keeps configured environment references intact while learning their values", () => {
    vi.stubEnv("WPI_SECRET_TEST_KEY", "actual-environment-credential");
    const agentDir = path.join(tmp, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
      provider: { type: "api_key", key: "WPI_SECRET_TEST_KEY" },
    }));
    const session = new SessionSecrets(agentDir, "references");
    session.refresh(tmp);
    expect(session.redactor.redact("WPI_SECRET_TEST_KEY")).toBe("WPI_SECRET_TEST_KEY");
    expect(session.redactor.redact("actual-environment-credential")).toMatch(/^__WPI_SECRET_/);
  });

  it("redacts persisted mapping files even when read from another session", () => {
    const agentDir = path.join(tmp, "agent");
    const source = new SessionSecrets(agentDir, "source");
    const token = source.redactor.registerSecret("old-session-credential");
    const [scope, id] = token.slice("__WPI_SECRET_".length, -2).split("_");
    const filename = path.join(agentDir, "secret-redaction", scope, `${id}.json`);
    const target = new SessionSecrets(agentDir, "target");
    target.scanFile(filename);
    expect(target.redactor.redact(fs.readFileSync(filename, "utf8"))).not.toContain("old-session-credential");
  });

  it("learns changed files and decoded multiline dotenv values", () => {
    const filename = path.join(tmp, ".env");
    const session = new SessionSecrets(path.join(tmp, "agent"), "updates");
    fs.writeFileSync(filename, 'PRIVATE_KEY="line-one\\nline-two"');
    session.scanFile(filename);
    expect(session.redactor.redact("line-one\nline-two")).not.toContain("line-one");
    fs.writeFileSync(filename, "API_KEY=a-new-credential-value");
    session.scanFile(filename);
    expect(session.redactor.redact("a-new-credential-value")).toMatch(/^__WPI_SECRET_/);
  });

  it("learns dotenv values whole, whatever they look like", () => {
    const session = new SessionSecrets(path.join(tmp, "agent"), "dotenv");
    fs.writeFileSync(path.join(tmp, ".env"), [
      "# comment",
      "SMTP_PASSWORD=abcdefghijklmnop",            // letters only: looks like an identifier
      "DB_PASSWORD=hunter(two)   # inline comment", // looks like a call
      "export API_TOKEN=ab,cd#ef;gh\r",             // punctuation the free-text scan stops at
      "PORT=3000",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(tmp, ".npmrc"), "//registry.npmjs.org/:_authToken=npmlegacytokenvalue\n");
    session.refresh(tmp);
    for (const value of ["abcdefghijklmnop", "hunter(two)", "ab,cd#ef;gh", "npmlegacytokenvalue"]) {
      const text = `unlabeled ${value} in a log line`;
      const result = session.redactor.redact(text);
      expect(result, value).not.toContain(value);
      expect(session.redactor.restore(result), value).toBe(text);
    }
    expect(session.redactor.redact("PORT=3000 # inline comment")).toBe("PORT=3000 # inline comment");
  });

  it("learns unquoted letters-only values from configuration files as full secrets", () => {
    const session = new SessionSecrets(path.join(tmp, "agent"), "config-files");
    const yamlFile = path.join(tmp, "config.yml");
    fs.writeFileSync(yamlFile, "db:\n  password: correcthorsebattery  # rotate me\n  - token: null\n  enabled_auth: true\n");
    const iniFile = path.join(tmp, "app.ini");
    fs.writeFileSync(iniFile, "[smtp]\nsecret = anotherlettersonly\n");
    session.scanFile(yamlFile); session.scanFile(iniFile);
    for (const value of ["correcthorsebattery", "anotherlettersonly"]) {
      const text = `postgres://app:${value}@db/main`;
      expect(session.redactor.redact(text), value).not.toContain(value);
      expect(session.redactor.restore(session.redactor.redact(text)), value).toBe(text);
    }
  });

  it("does not apply dotenv rules to source files", () => {
    const session = new SessionSecrets(path.join(tmp, "agent"), "source");
    const filename = path.join(tmp, "auth.ts");
    fs.writeFileSync(filename, "const password = generatePassword();\nconst token = accessToken;\n");
    session.scanFile(filename);
    expect(session.redactor.redact("call generatePassword() then use accessToken")).toBe("call generatePassword() then use accessToken");
  });

  it("skips symlinks and oversized sources", () => {
    const target = path.join(tmp, "target");
    fs.writeFileSync(target, "API_KEY=symlink-only-secret");
    fs.symlinkSync(target, path.join(tmp, ".env"));
    const big = path.join(tmp, ".env.big");
    fs.writeFileSync(big, "a".repeat(1024 * 1024 + 1));
    const session = new SessionSecrets(path.join(tmp, "agent"), "bounded");
    session.scanFile(path.join(tmp, ".env"));
    session.scanFile(big);
    expect(session.redactor.size).toBe(0);
  });
});
