import type { ChatMessage } from "../llm/types.js";

interface Session {
  messages: ChatMessage[];
  updatedAt: number;
}

/**
 * Per-customer conversation memory (in-memory, with TTL + size cap).
 * Replace with Redis/DB for multi-instance deployments.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly opts: { maxMessages?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get(id: string): ChatMessage[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    if (this.now() - s.updatedAt > (this.opts.ttlMs ?? 30 * 60_000)) {
      this.sessions.delete(id);
      return [];
    }
    return [...s.messages];
  }

  save(id: string, messages: ChatMessage[]): void {
    this.sessions.set(id, { messages: trimHistory(messages, this.opts.maxMessages ?? 30), updatedAt: this.now() });
  }

  reset(id: string): void {
    this.sessions.delete(id);
  }
}

/**
 * Keep the most recent messages, but always cut at a user turn so we
 * never leave an orphaned tool result without its assistant tool_call.
 */
export function trimHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start]?.role !== "user") start++;
  return messages.slice(start);
}
