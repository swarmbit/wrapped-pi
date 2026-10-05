import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.fn();
vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("typebox", () => ({ Type: {
  Object: vi.fn(() => ({})), String: vi.fn(() => ({})), Number: vi.fn(() => ({})),
  Boolean: vi.fn(() => ({})), Optional: vi.fn(value => value),
} }));

let tmp: string;
beforeEach(() => {
  vi.resetModules();
  complete.mockReset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpi-web-redaction-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(tmp, "agent"));
  vi.stubEnv("WEB_VERIFY_ENABLED", "true");
  vi.stubEnv("WEB_VERIFY_MODEL", "guard-model");
  vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-test-key");
  vi.stubEnv("FIRECRAWL_ALLOWED_DOMAINS", "");
  vi.stubEnv("FIRECRAWL_CACHE_TTL", "0");
  vi.stubEnv("WEB_SCREENSHOT_URL", "");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    success: true, data: { markdown: "Configuration: API_KEY=page-test-credential" },
  }), { headers: { "content-type": "application/json" } })));
  complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: '{"safe":true,"reason":"ok"}' }] });
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("direct guard LLM redaction", () => {
  it("redacts the structured request and final payload, leaving authentication to Pi's registry", async () => {
    const web = await import("./index");
    const tools = new Map<string, any>();
    web.default({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: vi.fn() } as any);
    const guard = { id: "guard-model" };
    const ctx = {
      cwd: tmp, sessionManager: { getSessionId: () => "web-test" },
      modelRegistry: { getAll: () => [guard], hasConfiguredAuth: () => true, complete },
    };
    await tools.get("web_fetch").execute("test", { url: "https://example.invalid" }, undefined, undefined, ctx);
    expect(complete).toHaveBeenCalledOnce();
    const [model, content, options] = complete.mock.calls[0];
    expect(model).toBe(guard);
    expect(JSON.stringify(content)).not.toContain("page-test-credential");
    expect(JSON.stringify(content)).toContain("__WPI_SECRET_");
    // Credentials are resolved by the registry at request time, never supplied here.
    expect(options).not.toHaveProperty("apiKey");
    expect(options.onPayload({ messages: [{ content: "page-test-credential" }] }).messages[0].content)
      .toMatch(/^__WPI_SECRET_/);
  });
});
