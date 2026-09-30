import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactForLlm } from "../secret-redaction/state.js";

export const OUTGOING_MAIL = "wpi-multiagent-outgoing";
export const INCOMING_MAIL = "wpi-multiagent-mail";
export const MAIL_ACK = "wpi-multiagent-mail-ack";
export const MAX_MAIL_TEXT = 4000;
export type MailKind = "update" | "question" | "result";
export interface OutgoingMail { id: string; kind: MailKind; text: string }
export interface Mail extends OutgoingMail { childId: string; agent: string; receivedAt: number; acknowledged: boolean }

export function validOutgoing(value: unknown): value is OutgoingMail {
  const mail = value as OutgoingMail | undefined;
  return !!mail && typeof mail.id === "string" && /^[a-f0-9-]{36}$/.test(mail.id)
    && ["update", "question", "result"].includes(mail.kind)
    && typeof mail.text === "string" && !!mail.text.trim() && mail.text.length <= MAX_MAIL_TEXT;
}
export function mailId(mail: Pick<Mail, "childId" | "id">) { return `${mail.childId}:${mail.id}`; }

/** Branch-local durable inbox. Replay never generates fresh parent turns. */
export class Mailbox {
  private messages = new Map<string, Mail>();
  constructor(private persist: (type: string, data: unknown) => void) {}
  restore(entries: { type: string; customType?: string; data?: unknown }[]) {
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType === INCOMING_MAIL) {
        const mail = entry.data as Mail;
        if (validOutgoing(mail) && typeof mail.childId === "string" && typeof mail.agent === "string" && Number.isFinite(mail.receivedAt))
          this.messages.set(mailId(mail), { ...mail, acknowledged: false });
      } else if (entry.customType === MAIL_ACK && typeof entry.data === "string") {
        const mail = this.messages.get(entry.data);
        if (mail) mail.acknowledged = true;
      }
    }
  }
  receive(child: { id: string; agent: string }, outgoing: unknown): Mail | undefined {
    if (!validOutgoing(outgoing)) return;
    const mail: Mail = { id: outgoing.id, kind: outgoing.kind, text: outgoing.text,
      childId: child.id, agent: child.agent, receivedAt: Date.now(), acknowledged: false };
    const key = mailId(mail);
    if (this.messages.has(key)) return;
    // Persist before publishing/notification. Failure leaves the message retryable.
    this.persist(INCOMING_MAIL, mail);
    this.messages.set(key, mail);
    return mail;
  }
  list(childId?: string, includeRead = false, limit = 20) {
    return [...this.messages.values()].filter(m => (!childId || m.childId === childId) && (includeRead || !m.acknowledged))
      .slice(0, Math.max(1, Math.min(50, limit))).map(m => ({ ...m, messageId: mailId(m) }));
  }
  acknowledge(id: string) {
    const mail = this.messages.get(id);
    if (!mail) throw new Error(`Unknown mailbox message: ${id}`);
    if (!mail.acknowledged) { this.persist(MAIL_ACK, id); mail.acknowledged = true; }
    return { messageId: id, acknowledged: true };
  }
  get unread() { return [...this.messages.values()].filter(m => !m.acknowledged).length; }
}

/** Loaded only inside managed children, including agents with restricted tools. */
export function registerParentMailbox(pi: ExtensionAPI) {
  pi.registerTool({
    name: "multiagent_parent", label: "Message parent",
    description: "Send a short update, question, or result to your parent agent's mailbox. Delivery occurs at the end of this tool turn; it notifies the parent without waiting for a reply. For a question, finish your turn and let the parent continue your conversation using send/steer. Do not poll or assume a reply has arrived. This sends only your message, not your transcript.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("update"), Type.Literal("question"), Type.Literal("result")]),
      message: Type.String({ minLength: 1, maxLength: MAX_MAIL_TEXT }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Cancelled");
      if (!params.message.trim()) throw new Error("A message is required");
      const outgoing: OutgoingMail = redactForLlm({ id: randomUUID(), kind: params.kind, text: params.message }, ctx);
      if (!validOutgoing(outgoing)) throw new Error(`Mailbox message must be at most ${MAX_MAIL_TEXT} characters after redaction`);
      pi.sendMessage({ customType: OUTGOING_MAIL, content: `You sent a ${outgoing.kind} to the parent (this is not a reply):\n\n${outgoing.text}`, display: false, details: outgoing }, { triggerTurn: false });
      return { content: [{ type: "text", text: "Queued for parent delivery at the end of this tool turn. A reply, if needed, will arrive as a new message in this conversation." }], details: { id: outgoing.id, kind: outgoing.kind } };
    },
  });
}
