import type { AssistantMessage, ChatMessage, CompletionRequest, CompletionResult, LLMProvider, ToolCall } from "./types.js";

/**
 * A deterministic, rule-based stand-in for a real LLM.
 *
 * It speaks the exact same protocol as a real model (it emits `tool_calls`
 * and reads `tool` results), so the whole agent loop, the tools and the
 * WhatsApp layer can be exercised offline with no API key. It is NOT meant
 * to be smart - plug in a real model for natural conversations.
 */
export class MockLLM implements LLMProvider {
  readonly name = "mock";
  private seq = 0;

  constructor(private readonly opts: { today?: () => string } = {}) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const last = req.messages[req.messages.length - 1];
    if (!last) return text("Hi! How can I help?");
    if (last.role === "tool") return text(this.summarize(req.messages));
    if (last.role !== "user") return text("How else can I help?");
    // If tools were withheld (round limit), we must answer in text.
    if (!req.tools || req.tools.length === 0) return text("Could you rephrase that?");
    return this.decide(last.content, req.messages);
  }

  // ---------------------------------------------------------------- intents

  private decide(input: string, messages: ChatMessage[]): CompletionResult {
    const msg = input.toLowerCase().trim();

    if (/^(hi|hello|hey|salam|bonjour|good (morning|afternoon|evening))\b[\s!.]*$/.test(msg)) {
      return text("Hi! 👋 I can help you find products or book a grooming, nail-trim, vet or training appointment. What do you need?");
    }
    if (/^(thanks|thank you|thx|merci|ok|great|perfect)\b/.test(msg)) {
      return text("You're welcome! Anything else I can help with?");
    }

    const booking = this.bookingState(messages);
    if (booking) {
      const { service, date, time, name } = booking;
      if (!service) return this.call("list_services", {});
      if (!date) return text(`Sure - what date would you like for the ${service} appointment? (e.g. tomorrow or 2026-10-12)`);
      if (time && name) return this.call("book_appointment", { service_id: service, date, time, customer_name: name });
      return this.call("check_availability", { service_id: service, date });
    }

    const id = msg.match(/\bp\d{3}\b/);
    if (id) return this.call("get_product_details", { product_id: id[0].toUpperCase() });

    const args: Record<string, unknown> = {};
    const price = msg.match(/(?:under|below|less than|max|cheaper than)\s*\$?\s*(\d+(?:\.\d+)?)/);
    if (price) args.max_price = Number(price[1]);
    if (/\bin stock\b|\bavailable\b/.test(msg)) args.in_stock_only = true;
    const query = msg
      .replace(/(?:under|below|less than|max|cheaper than)\s*\$?\s*\d+(?:\.\d+)?/g, " ")
      .replace(/\b(in stock|available|do you (have|sell)|can you|recommend|i'?m|looking for|any|good|best|cheap|price|cost|how much|show me|please)\b/g, " ")
      .replace(/[^\w\s-]/g, " ")
      .replace(/^\s*(a|an|the|some)\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (query) args.query = query;
    return this.call("search_products", args);
  }

  /** Collect booking slots from user messages since the last successful booking. */
  private bookingState(messages: ChatMessage[]) {
    let start = 0;
    messages.forEach((m, i) => {
      if (m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "book_appointment")) start = i + 1;
    });
    const userTexts = messages.slice(start).filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user").map((m) => m.content);
    const inFlow = userTexts.some((t) => /\b(book|booking|appointment|schedule|reserve|slots?)\b/i.test(t));
    if (!inFlow) return undefined;
    // The latest message must still be about the booking, otherwise treat it as a new question.
    const latest = userTexts[userTexts.length - 1] ?? "";
    const relevant =
      /\b(book|booking|appointment|schedule|reserve|slots?)\b/i.test(latest) ||
      [parseService, (x: string) => parseDate(x, this.today()), parseTime, parseName].some((f) => f(latest) !== undefined);
    if (!relevant) return undefined;

    const state: { service?: string; date?: string; time?: string; name?: string } = {};
    for (const t of userTexts) {
      state.service = parseService(t) ?? state.service;
      state.date = parseDate(t, this.today()) ?? state.date;
      state.time = parseTime(t) ?? state.time;
      state.name = parseName(t) ?? state.name;
    }
    return state;
  }

  private today(): string {
    if (this.opts.today) return this.opts.today();
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ------------------------------------------------------- tool -> reply text

  private summarize(messages: ChatMessage[]): string {
    // Find the assistant message that issued the tool calls we just got results for.
    let i = messages.length - 1;
    const results = new Map<string, unknown>();
    while (i >= 0 && messages[i]?.role === "tool") {
      const m = messages[i] as Extract<ChatMessage, { role: "tool" }>;
      results.set(m.tool_call_id, safeParse(m.content));
      i--;
    }
    const caller = messages[i] as AssistantMessage | undefined;
    const parts = (caller?.tool_calls ?? []).map((c) => describe(c.function.name, results.get(c.id)));
    return parts.join("\n\n") || "Done.";
  }

  private call(name: string, args: Record<string, unknown>): CompletionResult {
    const call: ToolCall = { id: `call_mock_${++this.seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
    return { message: { role: "assistant", content: null, tool_calls: [call] } };
  }
}

function describe(tool: string, raw: unknown): string {
  const r = (raw ?? {}) as Record<string, any>;
  if (r.error) return `Sorry, that didn't work: ${r.error}`;
  switch (tool) {
    case "search_products": {
      if (!r.count) return "I couldn't find anything matching that. Try another keyword (e.g. dog food, cat toy, shampoo).";
      const lines = (r.results as any[]).map(
        (p) => `• ${p.name} - $${p.price.toFixed(2)} ${p.in_stock ? "(in stock)" : "(out of stock)"} [${p.id}]`,
      );
      return `Here's what I found:\n${lines.join("\n")}\n\nAsk me about any item by its id for details.`;
    }
    case "get_product_details": {
      const p = r.product;
      return `${p.name} - $${p.price.toFixed(2)}\n${p.description}\n${p.in_stock ? `In stock (${p.stock} left).` : "Currently out of stock."}`;
    }
    case "list_services": {
      const lines = (r.services as any[]).map((s) => `• ${s.name} (${s.durationMinutes} min, $${s.price})`);
      return `We offer:\n${lines.join("\n")}\n\nWhich service would you like, and on what date?`;
    }
    case "check_availability": {
      if (r.closed) return `Sorry, there are no free slots on ${r.date}. Would another day work?`;
      return `Free times on ${r.date}: ${(r.free_slots as string[]).slice(0, 6).join(", ")}${r.free_slots.length > 6 ? " ..." : ""}\n\nReply with a time and your name (e.g. "10:30, my name is Sam") to book.`;
    }
    case "book_appointment": {
      const a = r.appointment;
      return `✅ Booked! ${a.service_name} on ${a.date} at ${a.time} for ${a.customerName}.\nReference: ${a.id}. See you then!`;
    }
    default:
      return JSON.stringify(r);
  }
}

// ------------------------------------------------------------------ parsers

export function parseService(t: string): string | undefined {
  const s = t.toLowerCase();
  if (/\bnail/.test(s)) return "nail-trim";
  if (/\bgroom/.test(s)) return "grooming";
  if (/\bvet\b|check-?up/.test(s)) return "vet-checkup";
  if (/\btrain/.test(s)) return "training";
  return undefined;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseDate(t: string, today: string): string | undefined {
  const s = t.toLowerCase();
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const base = new Date(`${today}T00:00:00Z`);
  const plus = (n: number) => new Date(base.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  if (/\btoday\b/.test(s)) return today;
  if (/\btomorrow\b/.test(s)) return plus(1);
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(s));
  if (wd >= 0) return plus(((wd - base.getUTCDay() + 7) % 7) || 7);
  return undefined;
}

export function parseTime(t: string): string | undefined {
  const s = t.toLowerCase();
  const m = s.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/) ?? s.match(/\b(\d{1,2})()\s*(am|pm)\b/) ?? s.match(/\bat (\d{1,2})()\b(?!-)/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseName(t: string): string | undefined {
  // Explicit phrases accept any casing ("my name is sam").
  const explicit = t.match(/\b(?:my name is|name is|name:|call me)\s+([a-z][a-z'-]*)/i);
  if (explicit?.[1]) return capitalize(explicit[1]);
  // "I'm Sam" only when the word is capitalized (avoids "I'm looking for...").
  const implicit = t.match(/\b(?:[Ii] am|[Ii]'m)\s+([A-Z][a-zA-Z'-]+)/);
  return implicit?.[1];
}

const capitalize = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

const text = (content: string): CompletionResult => ({ message: { role: "assistant", content } });
const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
