import { test } from "node:test";
import assert from "node:assert/strict";
import { Assistant } from "../src/assistant/assistant.js";
import { MockLLM, parseDate, parseName, parseService, parseTime } from "../src/llm/mock.js";
import { createTools } from "../src/tools/index.js";
import { loadAppointments, loadCatalog, silentLogger } from "./helpers.js";

function setup() {
  const appointments = loadAppointments();
  const assistant = new Assistant({
    llm: new MockLLM({ today: () => "2026-10-05" }),
    tools: createTools({ catalog: loadCatalog(), appointments }),
    systemPrompt: () => "SYSTEM",
    logger: silentLogger,
  });
  return { assistant, appointments };
}
const ctx = { customerId: "m1", channel: "cli" as const };

test("mock LLM: product search via tool call, with price filter", async () => {
  const { assistant } = setup();
  const out = await assistant.handleMessage("dog food under $30", ctx);
  assert.equal(out.toolCalls[0]?.name, "search_products");
  assert.deepEqual(out.toolCalls[0]?.args, { max_price: 30, query: "dog food" });
  assert.match(out.reply, /Puppy Starter Kibble/);
  assert.doesNotMatch(out.reply, /Grain-Free Salmon/); // $54.99 is over budget
});

test("mock LLM: product details by id", async () => {
  const { assistant } = setup();
  const out = await assistant.handleMessage("tell me about p013", ctx);
  assert.equal(out.toolCalls[0]?.name, "get_product_details");
  assert.match(out.reply, /Pet Fountain/);
});

test("mock LLM: multi-turn booking flow ends with a confirmed appointment", async () => {
  const { assistant, appointments } = setup();

  const r1 = await assistant.handleMessage("I'd like to book an appointment", ctx);
  assert.equal(r1.toolCalls[0]?.name, "list_services");
  assert.match(r1.reply, /Full grooming session/);

  const r2 = await assistant.handleMessage("grooming please", ctx);
  assert.match(r2.reply, /what date/i);

  const r3 = await assistant.handleMessage("tomorrow", ctx);
  assert.deepEqual(r3.toolCalls[0]?.args, { service_id: "grooming", date: "2026-10-06" });
  assert.match(r3.reply, /09:00/);

  const r4 = await assistant.handleMessage("10:30, my name is sam", ctx);
  assert.equal(r4.toolCalls[0]?.name, "book_appointment");
  assert.match(r4.reply, /Booked! Full grooming session on 2026-10-06 at 10:30 for Sam/);
  assert.equal(appointments.list().length, 1);

  // After booking, a product question is handled as a product question again.
  const r5 = await assistant.handleMessage("do you have shampoo?", ctx);
  assert.equal(r5.toolCalls[0]?.name, "search_products");
});

test("mock LLM: surfaces booking conflicts from the tool", async () => {
  const { assistant } = setup();
  await assistant.handleMessage("book a vet check-up on 2026-10-06 at 11:00, my name is Ana", { customerId: "a", channel: "cli" });
  const out = await assistant.handleMessage("book a vet check-up on 2026-10-06 at 11:00, my name is Bo", { customerId: "b", channel: "cli" });
  assert.equal(out.toolCalls[0]?.ok, false);
  assert.match(out.reply, /not available/);
});

test("mock LLM parsers", () => {
  assert.equal(parseService("can I get a nail trim"), "nail-trim");
  assert.equal(parseService("vet checkup"), "vet-checkup");
  assert.equal(parseDate("tomorrow", "2026-10-05"), "2026-10-06");
  assert.equal(parseDate("on friday", "2026-10-05"), "2026-10-09");
  assert.equal(parseDate("monday", "2026-10-05"), "2026-10-12", "same weekday means next week");
  assert.equal(parseTime("at 2:30 pm"), "14:30");
  assert.equal(parseTime("3pm"), "15:00");
  assert.equal(parseTime("at 10"), "10:00");
  assert.equal(parseTime("2026-10-06"), undefined);
  assert.equal(parseName("my name is lina"), "Lina");
  assert.equal(parseName("I'm Omar"), "Omar");
  assert.equal(parseName("I'm looking for food"), undefined);
});
