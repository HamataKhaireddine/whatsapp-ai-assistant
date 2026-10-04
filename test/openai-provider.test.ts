import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, LLMError } from "../src/llm/openai-compatible.js";
import { loadConfig } from "../src/config.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("sends an OpenAI-compatible request to the configured base URL", async () => {
  const { impl, calls } = fakeFetch([ok({ choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } })]);
  const llm = new OpenAICompatibleProvider({ apiKey: "sk-test-not-real", baseUrl: "https://llm.example.com/v1", model: "my-model", fetchImpl: impl });

  const out = await llm.complete({
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }],
  });

  assert.equal(out.message.content, "hi");
  assert.deepEqual(out.usage, { promptTokens: 5, completionTokens: 1 });
  assert.equal(calls[0]?.url, "https://llm.example.com/v1/chat/completions");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test-not-real");
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.model, "my-model");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools[0].function.name, "t");
});

test("parses tool_calls and omits tools when none are given", async () => {
  const tool_calls = [{ id: "c1", type: "function", function: { name: "search_products", arguments: '{"query":"leash"}' } }];
  const { impl, calls } = fakeFetch([ok({ choices: [{ message: { role: "assistant", content: null, tool_calls } }] })]);
  const llm = new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", model: "llama3.1", fetchImpl: impl });
  const out = await llm.complete({ messages: [{ role: "user", content: "leash?" }] });
  assert.deepEqual(out.message.tool_calls, tool_calls);
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.tools, undefined);
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, undefined, "no key -> no auth header (e.g. local Ollama)");
});

test("retries on 429/5xx, but not on 4xx", async () => {
  const flaky = fakeFetch([() => new Response("busy", { status: 503 }), ok({ choices: [{ message: { content: "recovered" } }] })]);
  const llm = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", model: "m", fetchImpl: flaky.impl, maxRetries: 2 });
  assert.equal((await llm.complete({ messages: [] })).message.content, "recovered");
  assert.equal(flaky.calls.length, 2);

  const bad = fakeFetch([() => new Response('{"error":"invalid key"}', { status: 401 })]);
  const llm2 = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", model: "m", fetchImpl: bad.impl, maxRetries: 2 });
  await assert.rejects(llm2.complete({ messages: [] }), (e: Error) => e instanceof LLMError && e.status === 401);
  assert.equal(bad.calls.length, 1);
});

test("config: provider selection and base URL normalisation", () => {
  assert.equal(loadConfig({}).llm.provider, "mock");
  const c = loadConfig({ OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "https://openrouter.ai/api/v1/", OPENAI_MODEL: "some/model" });
  assert.equal(c.llm.provider, "openai");
  assert.equal(c.llm.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(c.llm.model, "some/model");
  assert.equal(loadConfig({ OPENAI_API_KEY: "sk-x", LLM_PROVIDER: "mock" }).llm.provider, "mock");
  assert.throws(() => loadConfig({ LLM_PROVIDER: "openai" }), /requires OPENAI_API_KEY/);
  assert.throws(() => loadConfig({ LLM_PROVIDER: "claude" }), /must be "openai" or "mock"/);
});
