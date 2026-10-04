import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/server.js";
import { MockWhatsAppSender } from "../src/channels/whatsapp/client.js";
import { FIXED_NOW, silentLogger, testConfig, textWebhook } from "./helpers.js";

const APP_SECRET = "test-app-secret";
const sender = new MockWhatsAppSender();
const pending: Promise<void>[] = [];
let server: Server;
let base: string;

before(async () => {
  const app = createApp({ config: testConfig({ WHATSAPP_APP_SECRET: APP_SECRET }), whatsappSender: sender, now: FIXED_NOW, logger: silentLogger });
  server = createHttpServer(app, { onWhatsAppDone: (p) => pending.push(p) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("GET /health reports mock mode", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", llm: "mock", whatsapp: "mock", products: 15 });
});

test("GET / serves the web chat", async () => {
  const res = await fetch(base + "/");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /Customer Assistant/);
});

test("POST /api/chat answers and keeps the session", async () => {
  const r1 = await postJson("/api/chat", { message: "book a grooming appointment tomorrow" });
  const d1 = (await r1.json()) as any;
  assert.equal(r1.status, 200);
  assert.ok(d1.sessionId);
  assert.equal(d1.toolCalls[0].name, "check_availability");

  const d2 = (await (await postJson("/api/chat", { sessionId: d1.sessionId, message: "15:00, my name is Rania" })).json()) as any;
  assert.equal(d2.toolCalls[0].name, "book_appointment");
  assert.match(d2.reply, /Booked!.*2026-10-06 at 15:00 for Rania/);
});

test("POST /api/chat validates input", async () => {
  assert.equal((await postJson("/api/chat", { message: "" })).status, 400);
  assert.equal((await postJson("/api/chat", "{oops")).status, 400);
  assert.equal((await postJson("/api/chat", { message: "x".repeat(2001) })).status, 413);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("GET /webhook verification", async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=4242`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "4242");
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=4242`);
  assert.equal(bad.status, 403);
});

test("POST /webhook: signed message -> assistant -> WhatsApp reply", async () => {
  const body = JSON.stringify(textWebhook("212633333333", "do you have a cat tree?"));
  const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
  const res = await postJson("/webhook", body, { "x-hub-signature-256": sig });
  assert.equal(res.status, 200);
  await Promise.all(pending);
  const reply = sender.sent.find((m) => m.to === "212633333333");
  assert.ok(reply, "a reply should have been sent");
  assert.match(reply.body, /Cat Tree with Scratching Posts/);
});

test("POST /webhook rejects bad signatures", async () => {
  const body = JSON.stringify(textWebhook("212644444444", "hi"));
  const res = await postJson("/webhook", body, { "x-hub-signature-256": "sha256=deadbeef" });
  assert.equal(res.status, 401);
});
