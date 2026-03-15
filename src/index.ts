import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { nanoid } from "nanoid";
import PostalMime from "postal-mime";

const app = new Hono<{ Bindings: Env }>();

const INBOX_TTL = 3600; // 1 hour in seconds

const PAYMENT_CONFIG = (env: Env) => ({
  "POST /": {
    accepts: [
      { scheme: "exact" as const, price: "$0.005", network: "eip155:8453", payTo: env.SERVER_ADDRESS as `0x${string}` },
      { scheme: "exact" as const, price: "$0.005", network: "eip155:137", payTo: env.SERVER_ADDRESS as `0x${string}` },
      { scheme: "exact" as const, price: "$0.005", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Create a disposable email inbox. No body needed.",
    mimeType: "application/json",
  },
  "POST /check": {
    accepts: [
      { scheme: "exact" as const, price: "$0.005", network: "eip155:8453", payTo: env.SERVER_ADDRESS as `0x${string}` },
      { scheme: "exact" as const, price: "$0.005", network: "eip155:137", payTo: env.SERVER_ADDRESS as `0x${string}` },
      { scheme: "exact" as const, price: "$0.005", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Check an inbox for messages. Send {\"inbox_id\": \"your-inbox-id\"}",
    mimeType: "application/json",
  },
});

app.use(stripeApiKeyMiddleware({ serviceName: "disposable-email" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware(PAYMENT_CONFIG)(c, next);
});

// Create inbox — no body needed
app.post("/", async (c) => {
  const id = nanoid(10);
  const host = new URL(c.req.url).hostname;
  const email = `${id}@${host}`;
  const expiresAt = new Date(Date.now() + INBOX_TTL * 1000).toISOString();

  const metadata = {
    email,
    inbox_id: id,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  };

  await c.env.INBOXES.put(`inbox:${id}`, JSON.stringify(metadata), {
    expirationTtl: INBOX_TTL,
  });

  await c.env.INBOXES.put(`inbox:${id}:messages`, JSON.stringify([]), {
    expirationTtl: INBOX_TTL,
  });

  return c.json(metadata);
});

// Check inbox for messages
app.post("/check", async (c) => {
  const body = await c.req.json<{ inbox_id?: string }>();
  if (!body?.inbox_id) {
    return c.json({ error: "Missing 'inbox_id' field" }, 400);
  }

  const id = body.inbox_id.trim();
  const metadataRaw = await c.env.INBOXES.get(`inbox:${id}`);
  if (!metadataRaw) {
    return c.json({ error: "Inbox not found or expired" }, 404);
  }

  const metadata = JSON.parse(metadataRaw);
  const messagesRaw = await c.env.INBOXES.get(`inbox:${id}:messages`);
  const messages = messagesRaw ? JSON.parse(messagesRaw) : [];

  return c.json({
    email: metadata.email,
    messages,
  });
});

app.get("/", (c) => {
  return c.json({
    service: "x402-disposable-email",
    description: "Create temporary email inboxes and check for messages. POST / to create, POST /check with {\"inbox_id\": \"...\"} to read.",
    price: "$0.005 per request (Base mainnet)",
  });
});

app.get("/.well-known/openapi.json", (c) => {
  return c.json({
    "openapi": "3.1.0",
    "info": {
      "title": "x402 Disposable Email",
      "description": "Create temporary email inboxes or check messages",
      "version": "1.0.0",
      "x-pricing": { "price": "$0.005", "currency": "USDC", "network": "Base (eip155:8453)" }
    },
    "servers": [{ "url": "https://inbox.camelai.io" }],
    "paths": {
      "/": {
        "post": {
          "summary": "Create a new disposable inbox",
          "description": "Creates a temporary email inbox (1hr TTL). No body required. Requires x402 payment ($0.005 USDC on Base).",
          "responses": {
            "200": { "description": "Inbox details (email, inbox_id, expires_at)", "content": { "application/json": {} } },
            "402": { "description": "Payment Required" }
          }
        },
        "get": {
          "summary": "Service info",
          "responses": { "200": { "description": "Service info", "content": { "application/json": {} } } }
        }
      },
      "/check": {
        "post": {
          "summary": "Check inbox for messages",
          "description": "Returns messages received by an inbox. Requires x402 payment ($0.005 USDC on Base).",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": ["inbox_id"],
                  "properties": {
                    "inbox_id": { "type": "string", "description": "The inbox ID returned from POST /" }
                  }
                }
              }
            }
          },
          "responses": {
            "200": { "description": "Email and messages", "content": { "application/json": {} } },
            "402": { "description": "Payment Required" },
            "404": { "description": "Inbox not found or expired" }
          }
        }
      }
    }
  });
});

// Export both fetch handler (Hono) and email handler (Cloudflare Email Workers)
export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: Env) {
    const recipient = message.to;
    // Extract local part (inbox ID) from recipient address
    const localPart = recipient.split("@")[0];

    // Check if inbox exists
    const metadataRaw = await env.INBOXES.get(`inbox:${localPart}`);
    if (!metadataRaw) {
      message.setReject("Inbox not found or expired");
      return;
    }

    // Read the raw email stream into an ArrayBuffer
    const rawEmail = await new Response(message.raw).arrayBuffer();

    // Parse with postal-mime
    const parser = new PostalMime();
    const parsed = await parser.parse(rawEmail);

    const emailMessage = {
      from: parsed.from?.address || message.from,
      subject: parsed.subject || "(no subject)",
      text: parsed.text || parsed.html || "",
      received_at: new Date().toISOString(),
    };

    // Append message to the inbox's message list
    const messagesRaw = await env.INBOXES.get(`inbox:${localPart}:messages`);
    const messages = messagesRaw ? JSON.parse(messagesRaw) : [];
    messages.push(emailMessage);

    // Get remaining TTL from metadata to keep messages aligned
    const metadata = JSON.parse(metadataRaw);
    const expiresAt = new Date(metadata.expires_at).getTime();
    const remainingTtl = Math.max(
      60,
      Math.floor((expiresAt - Date.now()) / 1000)
    );

    await env.INBOXES.put(
      `inbox:${localPart}:messages`,
      JSON.stringify(messages),
      { expirationTtl: remainingTtl }
    );
  },
};
