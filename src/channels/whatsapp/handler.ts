import type { Assistant } from "../../assistant/assistant.js";
import type { WhatsAppSender } from "./client.js";
import type { IncomingText } from "./webhook.js";

/**
 * Glue between incoming WhatsApp messages and the assistant.
 * - de-duplicates retried webhooks (Meta re-delivers if we're slow)
 * - processes each sender's messages sequentially to keep history consistent
 */
export class WhatsAppHandler {
  private seen = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly assistant: Assistant,
    private readonly sender: WhatsAppSender,
    private readonly logger: Pick<Console, "info" | "error"> = console,
  ) {}

  /** Returns a promise that resolves when all given messages have been answered. */
  handle(messages: IncomingText[]): Promise<void> {
    const jobs = messages.filter((m) => this.firstTime(m.messageId)).map((m) => this.enqueue(m));
    return Promise.all(jobs).then(() => undefined);
  }

  private enqueue(m: IncomingText): Promise<void> {
    const prev = this.queues.get(m.from) ?? Promise.resolve();
    const next = prev.then(() => this.process(m));
    this.queues.set(m.from, next);
    void next.finally(() => {
      if (this.queues.get(m.from) === next) this.queues.delete(m.from);
    });
    return next;
  }

  private async process(m: IncomingText): Promise<void> {
    try {
      await this.sender.markAsRead?.(m.messageId).catch(() => undefined);
      const { reply } = await this.assistant.handleMessage(m.text, { customerId: m.from, channel: "whatsapp" });
      await this.sender.sendText(m.from, reply);
    } catch (err) {
      this.logger.error(`[whatsapp] failed to handle ${m.messageId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private firstTime(id: string): boolean {
    const now = Date.now();
    if (this.seen.size > 5_000) {
      for (const [k, t] of this.seen) if (now - t > 3_600_000) this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}
