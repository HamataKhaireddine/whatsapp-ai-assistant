import { test } from "node:test";
import assert from "node:assert/strict";
import { Assistant } from "../src/assistant/assistant.js";
import { trimHistory } from "../src/assistant/sessions.js";
import { createTools } from "../src/tools/index.js";
import type { ChatMessage, LLMProvider } from "../src/llm/types.js";
import { ScriptedLLM, callTools, loadAppointments, loadCatalog, say, silentLogger, toolCall } from "./helpers.js";

const ctx = { customerId: "u1", channel: "web" as const };

function makeAssistant(llm: LLMProvider, maxToolRounds?: number) {
  const appointments = loadAppointments();
  const assistant = new Assistant({
    llm,
    tools: createTools({ catalog: loadCatalog(), appointments }),
    systemPrompt: () => "SYSTEM",
    logger: silentLogger,
    maxToolRounds,
  });
  return { assistant, appointments };
}

test("runs the tool-calling loop: LLM -> tool -> LLM -> answer", async () => {
  const llm = new ScriptedLLM([callTools(toolCall("search_products", { query: "harness" })), say("We have the No-Pull Harness for $24.99.")]);
  const { assistant } = makeAssistant(llm);

  const out = await assistant.handleMessage("do you sell harnesses?", ctx);

  assert.equal(out.reply, "We have the No-Pull Harness for $24.99.");
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0]?.ok, true);

  // First request: system + user, with tool specs attached.
  const [first, second] = llm.requests;
  assert.deepEqual(first?.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(first?.tools?.length, 5);
  // Second request includes the tool call and its JSON result.
  assert.deepEqual(second?.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  const toolMsg = second?.messages[3] as Extract<ChatMessage, { role: "tool" }>;
  assert.equal(JSON.parse(toolMsg.content).results[0].id, "P012");
});

test("executes parallel tool calls in one round and books end-to-end", async () => {
  const llm = new ScriptedLLM([
    callTools(toolCall("list_services", {}), toolCall("check_availability", { date: "2026-10-06", service_id: "grooming" })),
    callTools(toolCall("book_appointment", { date: "2026-10-06", time: "14:00", service_id: "grooming", customer_name: "Sam" })),
    say("Booked!"),
  ]);
  const { assistant, appointments } = makeAssistant(llm);
  const out = await assistant.handleMessage("book grooming 2026-10-06 14:00, I'm Sam", ctx);
  assert.equal(out.reply, "Booked!");
  assert.deepEqual(out.toolCalls.map((t) => t.name), ["list_services", "check_availability", "book_appointment"]);
  assert.equal(appointments.list().length, 1);
  assert.equal(appointments.list()[0]?.customerName, "Sam");
});

test("tool errors are fed back to the model instead of crashing", async () => {
  const llm = new ScriptedLLM([
    callTools(
      toolCall("book_appointment", { date: "2026-10-11", time: "10:00", service_id: "grooming", customer_name: "Sam" }), // Sunday: closed
      toolCall("does_not_exist", {}),
      toolCall("search_products", "{not json"),
      toolCall("check_availability", { date: "2026-10-06" }), // missing service_id
    ),
    say("Sorry, we're closed on Sundays."),
  ]);
  const { assistant } = makeAssistant(llm);
  const out = await assistant.handleMessage("book me sunday", ctx);
  assert.equal(out.reply, "Sorry, we're closed on Sundays.");
  assert.deepEqual(out.toolCalls.map((t) => t.ok), [false, false, false, false]);
  const results = llm.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse((m as any).content).error);
  assert.match(results[0], /No free slots/);
  assert.match(results[1], /unknown tool/);
  assert.match(results[2], /not valid JSON/);
  assert.match(results[3], /missing required argument "service_id"/);
});

test("enforces a max number of tool rounds, then forces a text answer", async () => {
  const loop = () => callTools(toolCall("list_services", {}))();
  const llm = new ScriptedLLM([loop, loop, (req) => (req.tools ? loop() : say("Here are our services.")())]);
  const { assistant } = makeAssistant(llm, 2);
  const out = await assistant.handleMessage("services?", ctx);
  assert.equal(out.reply, "Here are our services.");
  assert.equal(llm.requests[2]?.tools, undefined, "tools must be withheld on the final round");
});

test("keeps conversation history per customer", async () => {
  const llm = new ScriptedLLM([say("Hi Sam!"), say("Sure."), say("Hello stranger.")]);
  const { assistant } = makeAssistant(llm);
  await assistant.handleMessage("I'm Sam", ctx);
  await assistant.handleMessage("what's my name?", ctx);
  await assistant.handleMessage("hi", { customerId: "someone-else", channel: "web" });

  assert.deepEqual(llm.requests[1]?.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(llm.requests[2]?.messages.map((m) => m.role), ["system", "user"], "sessions must be isolated");
});

test("LLM failures produce a friendly fallback and don't corrupt history", async () => {
  const failing: LLMProvider = { name: "boom", complete: async () => { throw new Error("network down"); } };
  const { assistant } = makeAssistant(failing);
  const out = await assistant.handleMessage("hello", ctx);
  assert.match(out.reply, /trouble/);
  assert.deepEqual(assistant.sessions.get(ctx.customerId), []);
});

test("trimHistory never starts with an orphaned tool message", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "1" },
    { role: "assistant", content: null, tool_calls: [toolCall("list_services", {})] },
    { role: "tool", tool_call_id: "x", content: "{}" },
    { role: "assistant", content: "a" },
    { role: "user", content: "2" },
    { role: "assistant", content: "b" },
  ];
  const trimmed = trimHistory(msgs, 4);
  assert.equal(trimmed[0]?.role, "user");
  assert.deepEqual(trimmed.map((m) => m.role), ["user", "assistant"]);
});
