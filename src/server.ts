import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { App } from "./app.js";
import { parseIncomingMessages, verifySignature, verifyWebhook } from "./channels/whatsapp/webhook.js";
import { CHAT_PAGE } from "./web/page.js";

const MAX_BODY = 1_000_000;

/**
 * Plain node:http server (zero runtime dependencies).
 *   GET  /               -> minimal web chat UI
 *   GET  /health         -> liveness + mode info
 *   POST /api/chat       -> { sessionId?, message } => { sessionId, reply, toolCalls }
 *   POST /api/reset      -> { sessionId } clears conversation memory
 *   GET  /webhook        -> WhatsApp verification handshake
 *   POST /webhook        -> WhatsApp incoming messages
 */
export function createHttpServer(app: App, opts: { onWhatsAppDone?: (p: Promise<void>) => void } = {}): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, CHAT_PAGE, "text/html; charset=utf-8");

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          status: "ok",
          llm: app.llm.name,
          whatsapp: app.config.whatsapp.accessToken ? "cloud-api" : "mock",
          products: app.catalog.size,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = parseJson(await readBody(req)) as { sessionId?: unknown; message?: unknown } | undefined;
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return json(res, 400, { error: "`message` (non-empty string) is required" });
        if (message.length > 2000) return json(res, 413, { error: "message too long (max 2000 chars)" });
        const sessionId = typeof body?.sessionId === "string" && body.sessionId ? body.sessionId.slice(0, 100) : randomUUID();
        const result = await app.assistant.handleMessage(message, { customerId: `web:${sessionId}`, channel: "web" });
        return json(res, 200, { sessionId, ...result });
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const body = parseJson(await readBody(req)) as { sessionId?: string } | undefined;
        if (body?.sessionId) app.assistant.sessions.reset(`web:${body.sessionId}`);
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/webhook") {
        const challenge = verifyWebhook(url.searchParams, app.config.whatsapp.verifyToken);
        return challenge !== null ? send(res, 200, challenge, "text/plain") : send(res, 403, "Forbidden", "text/plain");
      }

      if (req.method === "POST" && url.pathname === "/webhook") {
        const raw = await readBody(req);
        const secret = app.config.whatsapp.appSecret;
        if (secret && !verifySignature(raw, header(req, "x-hub-signature-256"), secret)) {
          return send(res, 401, "Invalid signature", "text/plain");
        }
        const messages = parseIncomingMessages(parseJson(raw));
        // Acknowledge immediately; Meta retries if we take too long. Reply asynchronously.
        send(res, 200, "EVENT_RECEIVED", "text/plain");
        const done = app.whatsapp.handle(messages);
        opts.onWhatsAppDone?.(done);
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? "Internal error" : (err as Error).message });
    }
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Payload too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), "application/json");
