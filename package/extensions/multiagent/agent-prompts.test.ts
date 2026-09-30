import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { loadPrompts } from "../dynamic-system-prompts/prompts.js";

const root = path.resolve(__dirname, "../../..");
function agent(name: string) {
  return parseFrontmatter<Record<string, string>>(readFileSync(path.join(root, "package/extensions/subagent/agents", `${name}.md`), "utf8"));
}
function examples(text: string) {
  return text.split("\n").filter(line => line.startsWith('{"')).map(line => JSON.parse(line));
}

describe("parent-mediated expert and runner prompts", () => {
  it("restricts expert to the parent mailbox with valid question/result examples", () => {
    const { frontmatter, body } = agent("expert");
    expect(frontmatter.name).toBe("expert");
    expect(frontmatter.description).toBeTruthy();
    expect(frontmatter.tools).toBe("multiagent_parent");
    expect(frontmatter.model).toBe("openai-codex/gpt-6-astra:high");
    expect(body).toContain("finish your turn");
    expect(examples(body).map(example => example.kind)).toEqual(["question", "result"]);
    for (const example of examples(body)) expect(example.message.length).toBeLessThanOrEqual(4000);
  });
  it("preserves runner's execution loadout and adds bounded parent communication", () => {
    const { frontmatter, body } = agent("runner");
    expect(frontmatter.name).toBe("runner");
    expect(frontmatter.tools.split(",").map(tool => tool.trim())).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(frontmatter.model).toBe("openai-codex/gpt-6-luna:low");
    expect(body).toContain("multiagent_parent");
    expect(body).toContain("normal assistant response instead");
    expect(examples(body).map(example => example.kind)).toEqual(["question", "result"]);
    for (const example of examples(body)) expect(example.message.length).toBeLessThanOrEqual(4000);
  });
  it("discovers the selectable parent prompt with valid multiagent tool examples", () => {
    const prompt = loadPrompts(root, path.join(root, "nonexistent-agent-dir")).find(prompt => prompt.name === "multiagent");
    expect(prompt?.source).toBe("project");
    expect(prompt?.description).toBeTruthy();
    const calls = examples(prompt!.content);
    expect(calls.filter(call => call.action === "start").map(call => call.agent)).toEqual(["runner", "expert"]);
    for (const call of calls) {
      expect(["start", "inbox", "send", "ack"]).toContain(call.action);
      if (call.action === "start") expect(call.task).toBeTruthy();
      if (call.action === "send") { expect(call.id).toBeTruthy(); expect(call.message).toBeTruthy(); }
      if (call.action === "ack") expect(call.messageId).toBeTruthy();
      expect(call.agentScope).toBeUndefined();
    }
  });
});
