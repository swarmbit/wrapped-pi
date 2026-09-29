import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ compact: vi.fn() }));
import { compact } from "@earendil-works/pi-coding-agent";
import secretRedaction from "./index";
import { getSessionSecrets } from "./state";

let tmp: string;
let hooks: Record<string, (event: any, ctx: any) => any>;
let ctx: any;
const secret = "integration-test-password";
const apiKey = "provider-authentication-key";

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-redaction-hooks-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(tmp, "agent"));
  fs.writeFileSync(path.join(tmp, ".env"), `DB_PASSWORD=${secret}\nPORT=3000\n`);
  hooks = {};
  ctx = {
    cwd: tmp, hasUI: true, abort: vi.fn(), ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "session" },
    model: { id: "test-model", provider: "test" },
    modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey, headers: { "x-api-key": apiKey } }) },
  };
  secretRedaction({ on: (name: string, handler: any) => { hooks[name] = handler; }, getThinkingLevel: () => "medium" } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extension round trip", () => {
  it("starts automatically and redacts user input, system prompt, and structured provider bodies", async () => {
    await hooks.session_start({}, ctx);
    const input = await hooks.input({ text: `Use ${secret}`, images: [] }, ctx);
    expect(input.action).toBe("transform");
    expect(input.text).not.toContain(secret);
    const system = await hooks.before_agent_start({ systemPrompt: `Never print ${secret}` }, ctx);
    expect(system.systemPrompt).not.toContain(secret);
    expect(system.systemPrompt).toContain("placeholders");
    const payload = { model: "test-model", system: secret, messages: [{ role: "user", content: secret }], max_tokens: 2048 };
    const masked = await hooks.before_provider_request({ payload }, ctx);
    expect(JSON.stringify(masked)).not.toContain(secret);
    expect(masked.max_tokens).toBe(2048);
    expect(masked.model).toBe("test-model");
    expect(payload.system).toBe(secret);
    expect(hooks.before_provider_headers).toBeUndefined();
  });

  it("redacts read results, restores an edit, and redacts the edit result again", async () => {
    const result = await hooks.tool_result({ content: [{ type: "text", text: `DB_PASSWORD=${secret}` }], details: { diff: secret }, isError: false }, ctx);
    expect(JSON.stringify(result)).not.toContain(secret);
    const masked = result.content[0].text;
    const tool = { toolName: "edit", input: { path: ".env", edits: [{ oldText: masked, newText: `${masked}\nPORT=4000` }] } };
    expect(await hooks.tool_call(tool, ctx)).toBeUndefined();
    expect(tool.input.edits[0].oldText).toBe(`DB_PASSWORD=${secret}`);
    expect(tool.input.edits[0].newText).toBe(`DB_PASSWORD=${secret}\nPORT=4000`);
    const after = await hooks.tool_result({ content: [{ type: "text", text: `Changed ${secret}` }], details: tool.input, isError: false }, ctx);
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(fs.readFileSync(path.join(tmp, ".env"), "utf8")).toContain(secret);
  });

  it("scans a newly accessed nested file before its tool output loses context", async () => {
    const filename = path.join(tmp, "nested.env");
    fs.writeFileSync(filename, "API_KEY=nested-test-credential");
    await hooks.tool_call({ toolName: "read", input: { path: filename } }, ctx);
    const result = await hooks.tool_result({ content: [{ type: "text", text: "nested-test-credential" }], details: undefined, isError: false }, ctx);
    expect(result.content[0].text).toMatch(/^__WPI_SECRET_/);
  });

  it("keeps parent-to-subagent tasks tokenized", async () => {
    const redactor = getSessionSecrets(ctx).redactor;
    const task = redactor.redact(`Use ${secret}`);
    const event = { toolName: "subagent", input: { agent: "worker", task } };
    expect(await hooks.tool_call(event, ctx)).toBeUndefined();
    expect(event.input.task).toBe(task);
    const child = { ...ctx, sessionManager: { getSessionId: () => "child" } };
    expect(getSessionSecrets(child).redactor.restore(task)).toBe(`Use ${secret}`);
  });

  it("blocks unknown placeholders without mutating arguments", async () => {
    const input = { content: "__WPI_SECRET_missing__" };
    const result = await hooks.tool_call({ toolName: "write", input }, ctx);
    expect(result.block).toBe(true);
    expect(result.reason).toContain("Unknown secret placeholder");
    expect(input.content).toBe("__WPI_SECRET_missing__");
  });

  it("sanitizes historical content without mutating the original transcript", async () => {
    const messages = [{ role: "user", content: secret }, { role: "toolResult", content: [{ type: "text", text: secret }] }];
    const result = await hooks.context({ messages }, ctx);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(messages[0].content).toBe(secret);
  });
});

describe("summarization and failures", () => {
  it("sanitizes compaction inputs and outputs while preserving provider authentication", async () => {
    vi.mocked(compact).mockResolvedValue({ summary: `Summary ${secret}`, firstKeptEntryId: "id", tokensBefore: 100 });
    const event = {
      preparation: { messagesToSummarize: [{ content: secret }], turnPrefixMessages: [{ content: secret }], previousSummary: secret },
      customInstructions: `Focus on ${secret}`, signal: new AbortController().signal,
    };
    const result = await hooks.session_before_compact(event, ctx);
    const call = vi.mocked(compact).mock.calls[0];
    expect(JSON.stringify(call[0])).not.toContain(secret);
    expect(call[4]).not.toContain(secret);
    expect(call[2]).toBe(apiKey);
    expect(call[3]).toEqual({ "x-api-key": apiKey });
    expect(call[5]).toBe(event.signal);
    expect(result.compaction.summary).not.toContain(secret);
    expect(event.preparation.previousSummary).not.toContain(secret);
  });

  it("preserves default compaction behavior and original session messages", async () => {
    const message = { content: secret };
    const preparation = { messagesToSummarize: [message], turnPrefixMessages: [], previousSummary: secret };
    expect(await hooks.session_before_compact({ preparation }, ctx)).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
    expect(JSON.stringify(preparation)).not.toContain(secret);
    expect(message.content).toBe(secret);
  });

  it("sanitizes branch summary inputs without changing the default summarizer or session entries", async () => {
    const entry = { id: "entry-id", message: { content: secret } };
    const entries = [entry];
    const result = await hooks.session_before_tree({ preparation: {
      userWantsSummary: true, entriesToSummarize: entries, customInstructions: secret,
    }, signal: new AbortController().signal }, ctx);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(entries[0].id).toBe("entry-id");
    expect(entry.message.content).toBe(secret);
    expect(result.customInstructions).not.toContain(secret);
    expect(result.summary).toBeUndefined();
  });

  it("cancels failed summaries instead of falling back to an unredacted call", async () => {
    vi.mocked(compact).mockRejectedValue(new Error(`provider failure ${secret}`));
    const result = await hooks.session_before_compact({ preparation: {}, customInstructions: secret, signal: new AbortController().signal }, ctx);
    expect(result).toEqual({ cancel: true });
    expect(ctx.abort).toHaveBeenCalled();
    expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain(secret);
  });

  it("withholds payloads and tool output even when Pi would swallow a hook exception", async () => {
    const redactor = getSessionSecrets(ctx).redactor;
    vi.spyOn(redactor, "redact").mockImplementation(() => { throw new Error(`failure ${secret}`); });
    expect(await hooks.before_provider_request({ payload: { messages: [secret] } }, ctx)).toEqual({});
    expect(await hooks.context({ messages: [secret] }, ctx)).toEqual({ messages: [] });
    const result = await hooks.tool_result({ content: [{ type: "text", text: secret }], details: { secret } }, ctx);
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({});
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(ctx.abort).toHaveBeenCalled();
    expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain(secret);
  });
});
