import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DATA_DIR } from "../src/app.js";
import { Catalog } from "../src/stores/catalog.js";
import { AppointmentStore } from "../src/stores/appointments.js";
import type { CompletionRequest, CompletionResult, LLMProvider, ToolCall } from "../src/llm/types.js";

/** Monday 2026-10-05, 08:00 local time - before opening hours, so every slot that day is free. */
export const FIXED_NOW = () => new Date(2026, 9, 5, 8, 0, 0);

export const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

export const testConfig = (env: Record<string, string> = {}) => loadConfig({ LLM_PROVIDER: "mock", WHATSAPP_VERIFY_TOKEN: "test-verify", ...env });

export const loadCatalog = () => Catalog.fromFile(join(DATA_DIR, "products.json"));
export const loadAppointments = (now = FIXED_NOW) => AppointmentStore.fromFile(join(DATA_DIR, "services.json"), { now });

/** An LLM whose responses are scripted by the test. Records every request it receives. */
export class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly script: ((req: CompletionRequest) => CompletionResult)[]) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(structuredClone(req));
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedLLM: no more scripted responses");
    return step(req);
  }
}

let n = 0;
export const toolCall = (name: string, args: unknown): ToolCall => ({
  id: `call_${++n}`,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
export const say = (content: string) => (): CompletionResult => ({ message: { role: "assistant", content } });
export const callTools = (...calls: ToolCall[]) => (): CompletionResult => ({
  message: { role: "assistant", content: null, tool_calls: calls },
});

/** A realistic WhatsApp Cloud API webhook payload for one inbound text message. */
export function textWebhook(from: string, body: string, id = `wamid.${Math.random().toString(36).slice(2)}`) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
              contacts: [{ wa_id: from, profile: { name: "Test User" } }],
              messages: [{ from, id, timestamp: "1790000000", type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}
