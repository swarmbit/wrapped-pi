import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "./redactor";
import { SessionSecrets } from "./state";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-redaction-config-")); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("configured credential names", () => {
  it("adds normalized exact names for fields and text without disabling defaults", () => {
    const redactor = new SecretRedactor();
    redactor.setCredentialKeys(["CUSTOM_CODE"]);
    const original = { customCode: "field-value-123", password: ["default", "value", "123"].join("-"), CUSTOM_CODE_FILE: "ordinary-path", text: "custom-code='assignment-value-123'" };
    const masked = redactor.redact(original);
    expect(masked.customCode).toMatch(/^__WPI_SECRET_/);
    expect(masked.password).toMatch(/^__WPI_SECRET_/);
    expect(masked.text).not.toContain("assignment-value-123");
    expect(masked.CUSTOM_CODE_FILE).toBe("ordinary-path");
    expect(redactor.restore(masked)).toEqual(original);
  });

  it("merges user and project keys before scanning environment, dotenv, and YAML values", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "wpi.yml"), "secretRedaction:\n  keys: [CUSTOM_CODE]\n");
    fs.writeFileSync(path.join(project, ".pi", "wpi.yml"), 'secretRedaction:\n  keys: [serviceCode]\nserviceCode: "yaml-value\\nsecond-line"\n');
    fs.writeFileSync(path.join(project, ".env"), 'serviceCode="dotenv-value\\nsecond-line"\n');
    vi.stubEnv("CUSTOM_CODE", "environment-value-123");
    const session = new SessionSecrets(path.join(tmp, "agent"), "configured");
    session.refresh(project);
    for (const value of ["environment-value-123", "yaml-value\nsecond-line", "dotenv-value\nsecond-line"]) {
      expect(session.redactor.redact(value)).toMatch(/^__WPI_SECRET_/);
    }
  });

  it("reloads keys and rescans unchanged sources", () => {
    const config = path.join(tmp, "wpi.yml");
    fs.writeFileSync(config, "secretRedaction:\n  keys: []\n");
    fs.writeFileSync(path.join(tmp, ".env"), "CUSTOM_CODE=discovered-after-reload\n");
    const session = new SessionSecrets(path.join(tmp, "agent"), "reload");
    session.refresh(tmp);
    expect(session.redactor.redact("discovered-after-reload")).toBe("discovered-after-reload");
    fs.writeFileSync(config, "secretRedaction:\n  keys: [CUSTOM_CODE]\n");
    session.refresh(tmp);
    expect(session.redactor.redact("discovered-after-reload")).toMatch(/^__WPI_SECRET_/);
    fs.writeFileSync(config, "secretRedaction:\n  keys: []\n");
    session.refresh(tmp);
    expect(session.redactor.redact({ CUSTOM_CODE: "new-unclassified-value" })).toEqual({ CUSTOM_CODE: "new-unclassified-value" });
    expect(session.redactor.redact("discovered-after-reload")).toMatch(/^__WPI_SECRET_/);
  });

  it.each(["secretRedaction:\n  keys: CUSTOM_CODE", "secretRedaction:\n  keys: [123]", "secretRedaction:\n  keys: ['']", "secretRedaction: [broken YAML"])("rejects invalid config without exposing source text: %s", text => {
    fs.writeFileSync(path.join(tmp, "wpi.yml"), text);
    const session = new SessionSecrets(path.join(tmp, "agent"), "invalid");
    expect(() => session.refresh(tmp)).toThrow("Invalid secretRedaction.keys configuration");
  });
});
