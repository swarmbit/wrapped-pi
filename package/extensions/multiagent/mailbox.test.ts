import { describe, expect, it, vi } from "vitest";
vi.mock("../secret-redaction/state.js", () => ({ redactForLlm: vi.fn((value: any) => ({ ...value, text: value.text?.replace("sensitive-value", "MASKED") })) }));
import { INCOMING_MAIL, MAIL_ACK, OUTGOING_MAIL, Mailbox, mailId, registerParentMailbox, renderIncomingMail } from "./mailbox.js";
const outgoing = { id: "12345678-1234-1234-1234-123456789abc", kind: "question" as const, text: "Which file should I change?" };
const child = { id: "child-a", agent: "runner" };

describe("parent mailbox", () => {
  it("renders incoming mail as a readable themed card with expandable metadata", () => {
    const message = { role: "custom", customType: INCOMING_MAIL, content: "private wrapper text", details: {
      ...outgoing, childId: child.id, agent: child.agent, receivedAt: 1, acknowledged: false,
    }, display: true, timestamp: 2 } as any;
    const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
    const compact = renderIncomingMail(message, { expanded: false, outputPad: 1 }, theme as any)!.render(80).join("\n");
    expect(compact).toContain("QUESTION from runner (child-a)");
    expect(compact).toContain("Which file should I change?");
    expect(compact).not.toContain("private wrapper text");
    const expanded = renderIncomingMail(message, { expanded: true, outputPad: 1 }, theme as any)!.render(80).join("\n");
    expect(expanded).toContain("Mailbox ID: child-a:12345678-1234-1234-1234-123456789abc");
  });
  it("persists before publication, binds sender identity, and deduplicates replay", () => {
    const persist = vi.fn(); const inbox = new Mailbox(persist);
    const mail = inbox.receive(child, { ...outgoing, childId: "spoofed", agent: "spoofed" })!;
    expect(mail.childId).toBe(child.id); expect(mail.agent).toBe("runner");
    expect(persist).toHaveBeenCalledWith(INCOMING_MAIL, mail);
    expect(inbox.receive(child, outgoing)).toBeUndefined(); expect(inbox.unread).toBe(1);
    // Same sender-generated ID from a different child is independent.
    inbox.receive({ id: "child-b", agent: "expert" }, outgoing); expect(inbox.unread).toBe(2);
    expect(inbox.list("child-a")).toHaveLength(1);
  });
  it("reconstructs acknowledgements from the active branch without new notifications", () => {
    const entries: any[] = [];
    const inbox = new Mailbox((customType, data) => entries.push({ type: "custom", customType, data }));
    const mail = inbox.receive(child, outgoing)!; const id = mailId(mail);
    inbox.acknowledge(id); inbox.acknowledge(id);
    expect(entries.map(e => e.customType)).toEqual([INCOMING_MAIL, MAIL_ACK]);
    expect(inbox.list()).toEqual([]); expect(inbox.list(undefined, true)[0]?.acknowledged).toBe(true);
    const persist = vi.fn(); const restored = new Mailbox(persist); restored.restore(entries);
    expect(restored.unread).toBe(0); expect(restored.receive(child, outgoing)).toBeUndefined(); expect(persist).not.toHaveBeenCalled();
    const forkBeforeAck = new Mailbox(vi.fn()); forkBeforeAck.restore(entries.slice(0, 1)); expect(forkBeforeAck.unread).toBe(1);
    expect(() => restored.acknowledge("missing")).toThrow("Unknown mailbox");
  });
  it("validates bounded payloads and leaves failed persistence retryable", () => {
    const persist = vi.fn().mockImplementationOnce(() => { throw new Error("write failed"); }); const inbox = new Mailbox(persist);
    for (const value of [null, {}, { ...outgoing, id: "bad" }, { ...outgoing, text: " " }, { ...outgoing, text: "x".repeat(4001) }, { ...outgoing, kind: "command" }])
      expect(inbox.receive(child, value)).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    expect(() => inbox.receive(child, outgoing)).toThrow("write failed"); expect(inbox.unread).toBe(0);
    expect(inbox.receive(child, outgoing)).toBeDefined(); expect(inbox.unread).toBe(1);
  });
  it("registers a child tool that queues redacted persistent custom messages, not turns", async () => {
    let tool: any; const sendMessage = vi.fn();
    registerParentMailbox({ registerTool: (definition: any) => { tool = definition; }, sendMessage } as any);
    expect(tool.name).toBe("multiagent_parent");
    const result = await tool.execute("call", { kind: "result", message: "Found sensitive-value" }, undefined, undefined, {});
    const [message, options] = sendMessage.mock.calls[0];
    expect(message.customType).toBe(OUTGOING_MAIL); expect(message.details.text).toBe("Found MASKED");
    expect(message.content).toContain("Found MASKED"); expect(message.content).toContain("this is not a reply"); expect(options).toEqual({ triggerTurn: false });
    expect(result.content[0].text).toContain("Queued");
    await expect(tool.execute("call", { kind: "question", message: " " }, undefined, undefined, {})).rejects.toThrow("required");
    const controller = new AbortController(); controller.abort();
    await expect(tool.execute("call", { kind: "question", message: "test" }, controller.signal, undefined, {})).rejects.toThrow("Cancelled");
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
