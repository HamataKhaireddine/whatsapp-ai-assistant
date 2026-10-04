import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import { Assistant } from "./assistant/assistant.js";
import { systemPrompt } from "./assistant/prompt.js";
import { createLLM, type LLMProvider } from "./llm/index.js";
import { Catalog } from "./stores/catalog.js";
import { AppointmentStore, localDate } from "./stores/appointments.js";
import { createTools } from "./tools/index.js";
import { MockWhatsAppSender, WhatsAppCloudClient, type WhatsAppSender } from "./channels/whatsapp/client.js";
import { WhatsAppHandler } from "./channels/whatsapp/handler.js";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export interface AppDeps {
  config: AppConfig;
  llm?: LLMProvider;
  whatsappSender?: WhatsAppSender;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
  persistAppointments?: boolean;
}

export interface App {
  config: AppConfig;
  assistant: Assistant;
  catalog: Catalog;
  appointments: AppointmentStore;
  whatsapp: WhatsAppHandler;
  llm: LLMProvider;
}

/** Composition root: wires stores, tools, LLM and channels together. Everything is injectable for tests. */
export function createApp(deps: AppDeps): App {
  const { config } = deps;
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  const catalog = Catalog.fromFile(join(DATA_DIR, "products.json"));
  const appointments = AppointmentStore.fromFile(join(DATA_DIR, "services.json"), {
    now,
    persistPath: deps.persistAppointments ? join(DATA_DIR, "appointments.json") : undefined,
  });

  const today = () => localDate(now());
  const llm = deps.llm ?? createLLM(config.llm, { today });

  const assistant = new Assistant({
    llm,
    tools: createTools({ catalog, appointments }),
    systemPrompt: () =>
      systemPrompt({
        businessName: config.businessName,
        today: today(),
        weekday: now().toLocaleDateString("en-US", { weekday: "long" }),
      }),
    logger,
  });

  const sender =
    deps.whatsappSender ??
    (config.whatsapp.accessToken && config.whatsapp.phoneNumberId
      ? new WhatsAppCloudClient({
          accessToken: config.whatsapp.accessToken,
          phoneNumberId: config.whatsapp.phoneNumberId,
          apiVersion: config.whatsapp.apiVersion,
        })
      : new MockWhatsAppSender((l) => logger.info(l)));

  return { config, assistant, catalog, appointments, whatsapp: new WhatsAppHandler(assistant, sender, logger), llm };
}
