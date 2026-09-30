import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

export interface ModelOption {
  /** Exact provider/model ID; model IDs may themselves contain slashes. */
  model: string;
  summary: string;
}

function readModels(file: string): ModelOption[] | undefined {
  try {
    if (statSync(file).size > 128 * 1024) throw new Error();
    const config = yaml.load(readFileSync(file, "utf8"), { schema: yaml.JSON_SCHEMA }) as
      { orchestrator?: { models?: unknown } } | undefined;
    const models = config?.orchestrator?.models;
    if (models === undefined) return undefined;
    if (!Array.isArray(models) || models.length > 32) throw new Error();
    const seen = new Set<string>();
    return models.map(item => {
      if (!item || typeof item.model !== "string" || typeof item.summary !== "string") throw new Error();
      const model = item.model.trim();
      const summary = item.summary.trim();
      if (!/^[^\s/]+\/\S+$/.test(model) || model.length > 256 || !summary || summary.length > 2000 || seen.has(model)) throw new Error();
      seen.add(model);
      return { model, summary };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Never echo YAML snippets: the same file may contain credentials.
    throw new Error("Invalid orchestrator.models configuration in wpi.yml; expected unique provider/model IDs with non-empty summaries.");
  }
}

/** Read on creation so edits take effect without reloading. Project lists replace user lists. */
export function loadModelOptions(cwd: string, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): ModelOption[] {
  const project = readModels(join(cwd, ".pi", "wpi.yml"));
  return project ?? readModels(join(dirname(agentDir), "wpi.yml")) ?? [];
}

export function modelIdentity(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
