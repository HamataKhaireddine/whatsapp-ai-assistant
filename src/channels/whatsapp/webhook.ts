import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for the WhatsApp Cloud API webhook.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

export interface IncomingText {
  messageId: string;
  from: string; // sender's WhatsApp id (phone number, E.164 without "+")
  name?: string;
  text: string;
  timestamp: number;
  phoneNumberId?: string;
}

/** Handle the GET verification handshake. Returns the challenge to echo, or null if rejected. */
export function verifyWebhook(query: URLSearchParams, verifyToken: string): string | null {
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token");
  const challenge = query.get("hub.challenge");
  if (mode === "subscribe" && token !== null && challenge !== null && safeEqual(token, verifyToken)) return challenge;
  return null;
}

/** Validate the `X-Hub-Signature-256: sha256=<hex>` header against the raw request body. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice("sha256=".length), expected);
}

/**
 * Extract text messages from a webhook payload. Non-text messages
 * (images, reactions, ...) and status updates (sent/delivered/read) are ignored.
 */
export function parseIncomingMessages(payload: unknown): IncomingText[] {
  const out: IncomingText[] = [];
  const body = payload as WebhookPayload;
  if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        let text: string | undefined;
        if (m.type === "text") text = m.text?.body;
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        else if (m.type === "button") text = m.button?.text;
        if (!text || !m.from || !m.id) continue;
        out.push({
          messageId: m.id,
          from: m.from,
          name: names.get(m.from),
          text,
          timestamp: Number(m.timestamp ?? 0),
          phoneNumberId: value.metadata?.phone_number_id,
        });
      }
    }
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Subset of the webhook payload shape we care about.
interface WebhookPayload {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
        }[];
      };
    }[];
  }[];
}
