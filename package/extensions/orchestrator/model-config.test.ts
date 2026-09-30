import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadModelOptions, modelIdentity } from "./model-config";

let dir: string;
let cwd: string;
let agentDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orchestrator-model-config-"));
  cwd = join(dir, "project");
  agentDir = join(dir, "user", "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const user = (text: string) => writeFileSync(join(dir, "user", "wpi.yml"), text);
const project = (text: string) => writeFileSync(join(cwd, ".pi", "wpi.yml"), text);

describe("model selection configuration", () => {
  it("defaults to no selector options and reads user options", () => {
    expect(loadModelOptions(cwd, agentDir)).toEqual([]);
    user("orchestrator:\n  models:\n    - model: provider/model\n      summary: Routine work\n");
    expect(loadModelOptions(cwd, agentDir)).toEqual([{ model: "provider/model", summary: "Routine work" }]);
  });
  it("replaces rather than merges the user list, including an explicit empty list", () => {
    user("orchestrator:\n  models:\n    - model: provider/fast\n      summary: Simple tasks\n");
    project("orchestrator:\n  models:\n    - model: provider/strong\n      summary: Complex tasks\n");
    expect(loadModelOptions(cwd, agentDir)).toEqual([{ model: "provider/strong", summary: "Complex tasks" }]);
    project("orchestrator:\n  models: []\n");
    expect(loadModelOptions(cwd, agentDir)).toEqual([]);
  });
  it("inherits a user list when the project has unrelated settings and reloads edits", () => {
    project("docker:\n  ports: [3000]\n");
    user("orchestrator:\n  models:\n    - model: provider/fast\n      summary: Simple tasks\n");
    expect(loadModelOptions(cwd, agentDir)[0].model).toBe("provider/fast");
    user("orchestrator:\n  models: []\n");
    expect(loadModelOptions(cwd, agentDir)).toEqual([]);
  });
  it.each([
    "orchestrator:\n  models: invalid",
    "orchestrator:\n  models: [null]",
    "orchestrator:\n  models: [{model: fast, summary: Task}]",
    "orchestrator:\n  models: [{model: provider/fast, summary: ''}]",
    "orchestrator:\n  models: [{model: provider/fast, summary: Task}, {model: provider/fast, summary: Task}]",
    "orchestrator: [broken YAML",
  ])("rejects malformed config without echoing YAML", text => {
    project(text);
    expect(() => loadModelOptions(cwd, agentDir)).toThrow("Invalid orchestrator.models configuration");
  });
  it("preserves slashes in the model ID", () => {
    expect(modelIdentity("openrouter/vendor/model")).toEqual({ provider: "openrouter", id: "vendor/model" });
  });
});
