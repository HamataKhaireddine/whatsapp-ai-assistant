import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseIncomingMessages, verifySignature, verifyWebhook } from "../src/channels/whatsapp/webhook.js";
import { WhatsAppCloudClient, MockWhatsAppSender, chunkMessage } from "../src/channels/whatsapp/client.js";
import { WhatsAppHandler } from "../src/channels/whatsapp/handler.js";
import { Assistant } from "../src/assistant/assistant.js";
import { ScriptedLLM, say, silentLogger, textWebhook } from "./helpers.js";

test("webhook verification handshake", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  assert.equal(verifyWebhook(q({ "hub.mode": "subscribe", "hub.verify_token": "secret", "hub.challenge": "123" }), "secret"), "123");
  assert.equal(verifyWebhook(q({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "123" }), "secret"), null);
  assert.equal(verifyWebhook(q({ "hub.mode": "unsubscribe", "hub.verify_token": "secret", "hub.challenge": "1" }), "secret"), null);
});

test("X-Hub-Signature-256 validation", () => {
  const body = JSON.stringify({ hello: "world" });
  const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "app-secret"), true);
  assert.equal(verifySignature(body + " ", sig, "app-secret"), false);
  assert.equal(verifySignature(body, sig, "other-secret"), false);
  assert.equal(verifySignature(body, undefined, "app-secret"), false);
});

test("parses text and interactive messages, ignores statuses and media", () => {
  const payload = textWebhook("212611111111", "hello", "wamid.A");
  const value = payload.entry[0]!.changes[0]!.value as any;
  value.messages.push({ from: "212611111111", id: "wamid.B", timestamp: "1", type: "image", image: { id: "img" } });
  value.messages.push({ from: "212611111111", id: "wamid.C", timestamp: "2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Book now" } } });
  value.statuses = [{ id: "wamid.X", status: "delivered" }];

  const msgs = parseIncomingMessages(payload);
  assert.deepEqual(msgs.map((m) => [m.messageId, m.text]), [["wamid.A", "hello"], ["wamid.C", "Book now"]]);
  assert.equal(msgs[0]?.name, "Test User");
  assert.equal(msgs[0]?.phoneNumberId, "PHONE_ID");
  assert.deepEqual(parseIncomingMessages({ object: "page" }), []);
  assert.deepEqual(parseIncomingMessages(null), []);
});

test("Cloud API client posts the documented payload", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new WhatsAppCloudClient({ accessToken: "TEST_TOKEN", phoneNumberId: "PHONE_ID", apiVersion: "v21.0", fetchImpl });
  await client.sendText("212611111111", "Hello!");

  assert.equal(calls[0]?.url, "https://graph.facebook.com/v21.0/PHONE_ID/messages");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer TEST_TOKEN");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "212611111111",
    type: "text",
    text: { preview_url: false, body: "Hello!" },
  });
});

test("Cloud API errors are surfaced", async () => {
  const fetchImpl = (async () => new Response('{"error":{"message":"bad token"}}', { status: 401 })) as unknown as typeof fetch;
  const client = new WhatsAppCloudClient({ accessToken: "x", phoneNumberId: "y", fetchImpl });
  await assert.rejects(client.sendText("1", "hi"), /WhatsApp API 401/);
});

test("long replies are chunked under the 4096-char limit", () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const chunks = chunkMessage(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.join("\n"), long);
});

test("handler replies once per message id (dedupes Meta retries)", async () => {
  const llm = new ScriptedLLM([say("Hi from the bot"), say("second")]);
  const assistant = new Assistant({ llm, tools: [], systemPrompt: () => "S", logger: silentLogger });
  const sender = new MockWhatsAppSender();
  const handler = new WhatsAppHandler(assistant, sender, silentLogger);

  const msgs = parseIncomingMessages(textWebhook("212622222222", "hi", "wamid.SAME"));
  await handler.handle(msgs);
  await handler.handle(msgs); // retry of the same webhook
  assert.deepEqual(sender.sent, [{ to: "212622222222", body: "Hi from the bot" }]);
});
