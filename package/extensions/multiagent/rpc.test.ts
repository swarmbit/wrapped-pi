import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
import { JsonLines, RpcTransport } from "./rpc.js";
afterEach(() => vi.clearAllMocks());
function childFixture() {
  const child = new EventEmitter() as any;
  const requests: any[] = [];
  const stdout = new PassThrough();
  child.stdout = stdout; child.stderr = new PassThrough(); child.kill = vi.fn();
  child.stdin = new Writable({ write(chunk, _encoding, callback) { requests.push(JSON.parse(chunk.toString())); callback(); } });
  child.stdin.on("finish", () => child.emit("close", 0, null));
  mock.spawn.mockReturnValue(child);
  return { child, requests, reply: (record: any) => stdout.write(JSON.stringify(record) + "\n") };
}
describe("multiagent RPC", () => {
  it("frames LF/CRLF only, including Unicode separators and split UTF-8", () => {
    const received: any[] = [];
    const parser = new JsonLines(record => received.push(record));
    const bytes = Buffer.from(JSON.stringify({ text: "λ\u2028middle\u2029end" }) + "\r\n" + JSON.stringify({ second: true }) + "\n");
    for (const byte of bytes) parser.push(Buffer.from([byte]));
    expect(received).toEqual([{ text: "λ\u2028middle\u2029end" }, { second: true }]);
  });
  it("correlates simultaneous requests out of order and forwards UI records", async () => {
    const fixture = childFixture(); const events: any[] = [];
    const rpc = new RpcTransport("/tmp", ["--session", "/tmp/child.jsonl"], event => events.push(event), () => {});
    const first = rpc.request("get_state"); const second = rpc.request("get_messages");
    fixture.reply({ type: "response", id: fixture.requests[1].id, success: true, data: { messages: [] } });
    fixture.reply({ type: "response", id: fixture.requests[0].id, success: true, data: { sessionId: "child" } });
    expect(await first).toEqual({ sessionId: "child" }); expect(await second).toEqual({ messages: [] });
    fixture.reply({ type: "extension_ui_request", method: "confirm", id: "ui" }); expect(events[0].id).toBe("ui");
    rpc.respond({ id: "ui", cancelled: true }); expect(fixture.requests[2]).toEqual({ type: "extension_ui_response", id: "ui", cancelled: true });
    expect(mock.spawn.mock.calls[0][2].env.WPI_MULTIAGENT_CHILD).toBe("1");
    await rpc.close(); await rpc.close();
  });
  it("rejects commands and pending requests on failures without unhandled timers", async () => {
    const fixture = childFixture(); const exits: Error[] = [];
    const rpc = new RpcTransport("/tmp", [], () => {}, error => exits.push(error));
    const bad = rpc.request("prompt");
    fixture.reply({ type: "response", id: fixture.requests[0].id, success: false, error: "bad model" });
    await expect(bad).rejects.toThrow("bad model");
    const pending = rpc.request("get_state"); fixture.child.emit("close", 1, null);
    await expect(pending).rejects.toThrow("exited"); await expect(rpc.request("get_state")).rejects.toThrow("exited"); expect(exits).toHaveLength(1);
    await rpc.close();
  });
  it("fails closed on malformed protocol records", async () => {
    const fixture = childFixture(); const exits: Error[] = [];
    const rpc = new RpcTransport("/tmp", [], () => {}, error => exits.push(error));
    const pending = rpc.request("get_state"); fixture.child.stdout.write("not-json\n");
    await expect(pending).rejects.toThrow(); expect(exits).toHaveLength(1); expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
    await rpc.close();
  });
});
