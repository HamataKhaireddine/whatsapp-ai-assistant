import type { AppConfig } from "../config.js";
import { MockLLM } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { LLMProvider } from "./types.js";

export * from "./types.js";
export { MockLLM } from "./mock.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";

export function createLLM(cfg: AppConfig["llm"], opts: { today?: () => string } = {}): LLMProvider {
  if (cfg.provider === "mock") return new MockLLM(opts);
  return new OpenAICompatibleProvider({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
  });
}
