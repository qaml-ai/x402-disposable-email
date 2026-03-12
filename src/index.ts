import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import { nanoid } from "nanoid";
import PostalMime from "postal-mime";

const app = new Hono<{ Bindings: Env }>();

const INBOX_TTL = 3600; // 1 hour in seconds

// OpenAPI spec — must be before paymentMiddleware
app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 Disposable Email Service",
      description: "Create temporary disposable email inboxes and check for received messages. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://inbox.camelai.io" }],
  },
}));

// x402 payment gates
app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /inbox": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.005",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Create a temporary disposable email inbox",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {},
          },
        },
      },
      "GET /inbox/:id": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.005",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Check a disposable inbox for received messages",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              pathParams: {
                id: {
                  type: "string",
                  description: "The inbox ID",
                  required: true,
                },
              },
            },
          },
        },
      },
    })
  )
);

// Paid endpoint: create a temporary inbox
app.post("/inbox", describeRoute({
  description: "Create a temporary disposable email inbox. Expires after 1 hour. Requires x402 payment ($0.005).",
  responses: {
    200: { description: "Inbox created", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
  },
}), async (c) => {
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

// Paid endpoint: check inbox for messages
app.get("/inbox/:id", describeRoute({
  description: "Check a disposable inbox for received messages. Requires x402 payment ($0.005).",
  responses: {
    200: { description: "Inbox messages", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
    404: { description: "Inbox not found or expired" },
  },
}), async (c) => {
  const id = c.req.param("id");

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

// Free endpoint: delete inbox
app.delete("/inbox/:id", describeRoute({
  description: "Delete a disposable inbox (free).",
  responses: {
    200: { description: "Inbox deleted", content: { "application/json": { schema: { type: "object" } } } },
    404: { description: "Inbox not found or expired" },
  },
}), async (c) => {
  const id = c.req.param("id");

  const metadataRaw = await c.env.INBOXES.get(`inbox:${id}`);
  if (!metadataRaw) {
    return c.json({ error: "Inbox not found or expired" }, 404);
  }

  await c.env.INBOXES.delete(`inbox:${id}`);
  await c.env.INBOXES.delete(`inbox:${id}:messages`);

  return c.json({ deleted: true });
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
