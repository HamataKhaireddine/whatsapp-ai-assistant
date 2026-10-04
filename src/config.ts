import { existsSync } from "node:fs";

export interface AppConfig {
  port: number;
  businessName: string;
  llm: {
    provider: "openai" | "mock";
    apiKey?: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
  };
  whatsapp: {
    accessToken?: string;
    phoneNumberId?: string;
    verifyToken: string;
    appSecret?: string;
    apiVersion: string;
  };
}

/** Load `.env` (if present) using Node's built-in loader - no dotenv dependency. */
export function loadDotEnv(path = ".env"): void {
  if (existsSync(path) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
  }
}

const blank = (v: string | undefined): string | undefined => (v && v.trim() !== "" ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = blank(env.OPENAI_API_KEY);
  const requested = blank(env.LLM_PROVIDER)?.toLowerCase();
  if (requested && requested !== "openai" && requested !== "mock") {
    throw new Error(`LLM_PROVIDER must be "openai" or "mock" (got "${requested}")`);
  }
  const provider = (requested ?? (apiKey ? "openai" : "mock")) as "openai" | "mock";
  if (provider === "openai" && !apiKey && !blank(env.OPENAI_BASE_URL)?.includes("localhost")) {
    throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY (or a local OPENAI_BASE_URL such as Ollama)");
  }

  return {
    port: Number(env.PORT ?? 3000),
    businessName: blank(env.BUSINESS_NAME) ?? "Pawsome Pet Supplies",
    llm: {
      provider,
      apiKey,
      baseUrl: (blank(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      model: blank(env.OPENAI_MODEL) ?? "gpt-4o-mini",
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 30_000),
    },
    whatsapp: {
      accessToken: blank(env.WHATSAPP_ACCESS_TOKEN),
      phoneNumberId: blank(env.WHATSAPP_PHONE_NUMBER_ID),
      verifyToken: blank(env.WHATSAPP_VERIFY_TOKEN) ?? "change-me",
      appSecret: blank(env.WHATSAPP_APP_SECRET),
      apiVersion: blank(env.WHATSAPP_API_VERSION) ?? "v21.0",
    },
  };
}
