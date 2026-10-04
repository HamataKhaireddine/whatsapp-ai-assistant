import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../src/tools/index.js";
import { toSpec, validateArgs } from "../src/tools/types.js";
import { loadAppointments, loadCatalog } from "./helpers.js";

const tools = createTools({ catalog: loadCatalog(), appointments: loadAppointments() });
const byName = (n: string) => tools.find((t) => t.name === n)!;
const ctx = { customerId: "212600000000", channel: "whatsapp" as const };

test("exposes the five tools as valid OpenAI function specs", () => {
  assert.deepEqual(tools.map((t) => t.name), ["search_products", "get_product_details", "list_services", "check_availability", "book_appointment"]);
  for (const t of tools) {
    const spec = toSpec(t);
    assert.equal(spec.type, "function");
    assert.equal((spec.function.parameters as any).type, "object");
    assert.ok(spec.function.description.length > 20);
  }
  const bookSpec = toSpec(byName("book_appointment")).function.parameters as any;
  assert.deepEqual(bookSpec.required, ["date", "time", "service_id", "customer_name"]);
  assert.deepEqual(bookSpec.properties.service_id.enum, ["grooming", "nail-trim", "vet-checkup", "training"]);
});

test("validateArgs catches missing, unknown, mistyped and out-of-enum arguments", () => {
  const book = byName("book_appointment");
  assert.deepEqual(validateArgs(book, { date: "2026-10-06", time: "10:00", service_id: "grooming", customer_name: "Sam" }), []);
  assert.match(validateArgs(book, { date: "2026-10-06" }).join(), /missing required argument "time"/);
  assert.match(validateArgs(book, { date: 1, time: "10:00", service_id: "grooming", customer_name: "S" }).join(), /must be of type string/);
  assert.match(validateArgs(book, { date: "x", time: "y", service_id: "spa", customer_name: "S" }).join(), /must be one of/);
  assert.match(validateArgs(byName("list_services"), { foo: 1 }).join(), /unknown argument "foo"/);
  assert.deepEqual(validateArgs(byName("search_products"), []), ["arguments must be a JSON object"]);
});

test("search_products returns a compact, model-friendly payload", async () => {
  const out = (await byName("search_products").handler({ query: "shampoo" }, ctx)) as any;
  assert.equal(out.count, 1);
  assert.deepEqual(Object.keys(out.results[0]).sort(), ["category", "description", "id", "in_stock", "name", "price", "stock"]);
});

test("book_appointment defaults contact to the WhatsApp sender", async () => {
  const out = (await byName("book_appointment").handler(
    { date: "2026-10-06", time: "09:00", service_id: "training", customer_name: "Noor" },
    ctx,
  )) as any;
  assert.equal(out.confirmed, true);
  assert.equal(out.appointment.contact, "212600000000");
  assert.equal(out.appointment.service_name, "Puppy training consultation");
});
