/**
 * Outgoing messages via the WhatsApp Cloud API (Graph API).
 * POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 */

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
  markAsRead?(messageId: string): Promise<void>;
}

/** WhatsApp caps text bodies at 4096 chars; split on line boundaries where possible. */
export function chunkMessage(body: string, max = 4096): string[] {
  if (body.length <= max) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class WhatsAppCloudClient implements WhatsAppSender {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: { accessToken: string; phoneNumberId: string; apiVersion?: string; fetchImpl?: typeof fetch },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get url() {
    return `https://graph.facebook.com/${this.opts.apiVersion ?? "v21.0"}/${this.opts.phoneNumberId}/messages`;
  }

  async sendText(to: string, body: string): Promise<void> {
    for (const chunk of chunkMessage(body)) {
      await this.post({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: chunk } });
    }
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.post({ messaging_product: "whatsapp", status: "read", message_id: messageId });
  }

  private async post(payload: unknown): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WhatsApp API ${res.status}: ${text.slice(0, 300)}`);
    }
  }
}

/** Used when no access token is configured: records/logs messages instead of sending them. */
export class MockWhatsAppSender implements WhatsAppSender {
  readonly sent: { to: string; body: string }[] = [];
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async sendText(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
    this.log(`[whatsapp:mock] -> ${to}: ${body.replace(/\n/g, " | ")}`);
  }
}
