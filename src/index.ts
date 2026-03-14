import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { nanoid } from "nanoid";
import PostalMime from "postal-mime";

const app = new Hono<{ Bindings: Env }>();

const INBOX_TTL = 3600; // 1 hour in seconds

const SYSTEM_PROMPT = `You are a parameter extractor for a disposable email inbox service.
Extract the following from the user's message and return JSON:
- "action": either "create" (create a new inbox) or "check" (check an existing inbox for messages). Default "create". (required)
- "inbox_id": the inbox ID to check. Required if action is "check". (optional)

If the user mentions creating, making, or getting a new email/inbox, set action to "create".
If the user mentions checking, reading, viewing messages, or provides an inbox ID, set action to "check".

Return ONLY valid JSON, no explanation.
Examples:
- {"action": "create"}
- {"action": "check", "inbox_id": "abc123def0"}`;

app.use(stripeApiKeyMiddleware({ serviceName: "disposable-email" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware(
    (env) => ({
      "POST /": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.005",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Create a disposable email inbox or check for received messages. Send {\"input\": \"your request\"}",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            info: {
              input: {
                type: "http",
                method: "POST",
                bodyType: "json",
                body: {
                  input: { type: "string", description: "Describe what you want: create a new inbox or check an existing one", required: true },
                },
              },
              output: { type: "json" },
            },
            schema: {
              properties: {
                input: {
                  properties: { method: { type: "string", enum: ["POST"] } },
                  required: ["method"],
                },
              },
            },
          },
        },
      },
    })
  )(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const action = ((params.action as string) || "create").toLowerCase();

  if (action === "check") {
    // --- Check inbox for messages ---
    const id = params.inbox_id as string;
    if (!id) {
      return c.json({ error: "Could not determine inbox_id to check" }, 400);
    }

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
  }

  // --- Create inbox (default) ---
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

  // Store inbox metadata with TTL
  await c.env.INBOXES.put(`inbox:${id}`, JSON.stringify(metadata), {
    expirationTtl: INBOX_TTL,
  });

  // Initialize empty messages list with same TTL
  await c.env.INBOXES.put(`inbox:${id}:messages`, JSON.stringify([]), {
    expirationTtl: INBOX_TTL,
  });

  return c.json(metadata);
});

app.get("/", (c) => {
  return c.json({
    service: "x402-disposable-email",
    description: "Create temporary disposable email inboxes and check for messages. Send POST / with {\"input\": \"create a new inbox\" or \"check inbox abc123def0\"}",
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
          "summary": "Create temporary email inboxes or check messages",
          "description": "Accepts natural language input. An LLM interprets your request and extracts the required parameters. Requires x402 payment ($0.005 USDC on Base).",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": ["input"],
                  "properties": {
                    "input": { "type": "string", "description": "Describe what you want: create a new inbox or check an existing one" }
                  }
                }
              }
            }
          },
          "responses": {
            "200": { "description": "Inbox details or messages", "content": { "application/json": {} } },
            "402": { "description": "Payment Required — sign a USDC payment on Base and resend with the payment header" },
            "400": { "description": "Bad request — could not interpret input" }
          }
        },
        "get": {
          "summary": "Service info",
          "description": "Returns service metadata, description, and pricing",
          "responses": { "200": { "description": "Service info", "content": { "application/json": {} } } }
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
