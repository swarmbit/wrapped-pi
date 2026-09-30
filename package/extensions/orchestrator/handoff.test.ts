import { describe, expect, it, vi } from "vitest";
import { prepareHandoff } from "./handoff";

const input = { request: "Continue that work", sourceSummary: "PKCE selected", destinationSummary: "OAuth implementation", switchReason: "Required prior context", preservationNotes: "Keep pending tests" };
function fixture() {
  const complete = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "PKCE was selected; tests remain unfinished." }], stopReason: "stop", usage: { input: 100, output: 20 } });
  const ctx: any = {
    cwd: "/tmp", hasUI: true, model: { id: "source-model" }, modelRegistry: { complete },
    sessionManager: { getSessionId: () => "handoff-test", getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Use PKCE" }] } }] },
    ui: { select: vi.fn().mockResolvedValue("Cancel switch"), input: vi.fn() },
  };
  const store: any = { record: vi.fn() };
  const backend: any = { evaluateHandoff: vi.fn().mockResolvedValue({ needed: false, usage: { input: 10 } }) };
  const prepare = () => prepareHandoff(input, ctx, backend, store, "virtual", "request");
  return { ctx, store, backend, complete, prepare };
}

describe("shared handoff pipeline", () => {
  it("lets the decision backend skip handoff without modifying the original request", async () => {
    const f = fixture();
    expect(await f.prepare()).toBe(input.request);
    expect(f.backend.evaluateHandoff).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.store.record).toHaveBeenCalledWith(expect.objectContaining({ source: "handoff-decision:request", category: "decision" }));
  });
  it("uses the source model without tools and appends labelled supporting context", async () => {
    const f = fixture();
    f.backend.evaluateHandoff.mockResolvedValue({ needed: true });
    const result = await f.prepare();
    expect(result?.startsWith(input.request + "\n\n")).toBe(true);
    expect(result).toContain("supporting context");
    expect(result).toContain("tests remain unfinished");
    const [model, context] = f.complete.mock.calls[0];
    expect(model).toBe(f.ctx.model);
    expect(context.tools).toEqual([]);
    expect(context.messages[0].content).toContain("Use PKCE");
    expect(f.store.record).toHaveBeenCalledWith(expect.objectContaining({ source: "handoff-summary:request", category: "summary", usage: expect.objectContaining({ input: 100, output: 20 }) }));
  });
  it.each(["backend", "invalid", "empty", "truncated", "api"])("holds the switch on %s failure", async mode => {
    const f = fixture();
    f.backend.evaluateHandoff.mockResolvedValue({ needed: true });
    if (mode === "backend") f.backend.evaluateHandoff.mockRejectedValue(new Error("offline"));
    if (mode === "invalid") f.backend.evaluateHandoff.mockResolvedValue({ needed: "no" });
    if (mode === "empty") f.complete.mockResolvedValue({ content: [], stopReason: "stop" });
    if (mode === "truncated") f.complete.mockResolvedValue({ content: [{ type: "text", text: "partial" }], stopReason: "length" });
    if (mode === "api") delete f.ctx.modelRegistry.complete;
    expect(await f.prepare()).toBeUndefined();
    expect(f.ctx.ui.select).toHaveBeenCalledOnce();
  });
  it("requires explicit confirmation when no decision backend is configured", async () => {
    const f = fixture();
    f.ctx.ui.select.mockResolvedValue("Proceed without handoff");
    expect(await prepareHandoff(input, f.ctx, undefined, f.store, "v", "r")).toBe(input.request);
    expect(f.store.record).not.toHaveBeenCalled();
  });
  it("accepts bounded manually supplied context after a decision failure", async () => {
    const f = fixture();
    f.backend.evaluateHandoff.mockRejectedValue(new Error("offline"));
    f.ctx.ui.select.mockResolvedValue("Provide handoff");
    f.ctx.ui.input.mockResolvedValue("Preserve PKCE");
    expect(await f.prepare()).toContain("Preserve PKCE");
  });
  it("holds noninteractive requests instead of silently discarding context", async () => {
    const f = fixture();
    f.ctx.hasUI = false;
    f.backend.evaluateHandoff.mockRejectedValue(new Error("offline"));
    expect(await f.prepare()).toBeUndefined();
    expect(f.ctx.ui.select).not.toHaveBeenCalled();
  });
});
