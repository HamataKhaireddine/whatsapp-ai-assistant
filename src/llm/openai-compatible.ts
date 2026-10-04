import type { CompletionRequest, CompletionResult, LLMProvider, AssistantMessage } from "./types.js";

export interface OpenAICompatibleOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class LLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * Talks to any endpoint implementing `POST {baseUrl}/chat/completions`
 * (OpenAI, Azure-style proxies, OpenRouter, Groq, Together, Ollama, vLLM, ...).
 * Uses plain fetch - no SDK lock-in.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = `openai-compatible(${opts.model})`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.opts.model,
      messages: req.messages,
      temperature: this.opts.temperature ?? 0.3,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools, tool_choice: "auto" } : {}),
    };

    const maxRetries = this.opts.maxRetries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new LLMError(`LLM request failed with ${res.status}: ${text.slice(0, 300)}`, res.status);
          // Retry only on rate limits and server errors.
          if (res.status === 429 || res.status >= 500) {
            lastError = err;
            await sleep(backoffMs(attempt));
            continue;
          }
          throw err;
        }

        const json = (await res.json()) as {
          choices?: { message?: Partial<AssistantMessage> }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const msg = json.choices?.[0]?.message;
        if (!msg) throw new LLMError("LLM response contained no choices");

        return {
          message: {
            role: "assistant",
            content: msg.content ?? null,
            ...(msg.tool_calls && msg.tool_calls.length > 0 ? { tool_calls: msg.tool_calls } : {}),
          },
          usage: json.usage
            ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
            : undefined,
        };
      } catch (err) {
        if (err instanceof LLMError && err.status !== undefined && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
        if (attempt < maxRetries) await sleep(backoffMs(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new LLMError(String(lastError));
  }
}

const backoffMs = (attempt: number) => Math.min(250 * 2 ** attempt, 4000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
