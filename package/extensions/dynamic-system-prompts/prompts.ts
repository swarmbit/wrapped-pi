import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

export interface SystemPrompt {
  name: string;
  description: string;
  content: string;
  source: "user" | "project";
}

export const MAX_PROMPT_BYTES = 64 * 1024;

/** Direct Markdown children only. Project names override user names. */
export function loadPrompts(cwd: string, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): SystemPrompt[] {
  const prompts = new Map<string, SystemPrompt>();
  for (const [directory, source] of [[join(agentDir, "system-prompts"), "user"], [join(cwd, ".pi", "system-prompts"), "project"]] as const) {
    let files;
    try { files = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read ${source} system-prompts directory.`);
    }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const name = file.name.slice(0, -3);
      if (!name || ["off", "status", "list"].includes(name)) throw new Error(`Reserved or empty system prompt name: ${file.name}`);
      try {
        const path = join(directory, file.name);
        if (statSync(path).size > MAX_PROMPT_BYTES) throw new Error();
        const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        let description = "";
        if (match) {
          const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) as { description?: unknown } | undefined;
          if (metadata?.description !== undefined && typeof metadata.description !== "string") throw new Error();
          description = metadata?.description?.trim() || "";
        }
        const content = (match ? text.slice(match[0].length) : text).trim();
        if (!content || Buffer.byteLength(content, "utf8") > MAX_PROMPT_BYTES) throw new Error();
        prompts.set(name, { name, description, content, source });
      } catch {
        // Do not include parser errors or file contents; prompts may contain private data.
        throw new Error(`Invalid ${source} system prompt ${file.name}: expected nonempty Markdown up to 64 KiB with optional description frontmatter.`);
      }
    }
  }
  return [...prompts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isSystemPrompt(value: unknown): value is SystemPrompt {
  if (!value || typeof value !== "object") return false;
  const prompt = value as SystemPrompt;
  return typeof prompt.name === "string" && !!prompt.name &&
    typeof prompt.description === "string" && typeof prompt.content === "string" && !!prompt.content.trim() &&
    Buffer.byteLength(prompt.content, "utf8") <= MAX_PROMPT_BYTES &&
    (prompt.source === "user" || prompt.source === "project");
}
