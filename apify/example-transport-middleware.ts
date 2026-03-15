/**
 * x402 Transport Middleware for Apify MCP Server
 *
 * Bridges the gap between:
 *   - Apify's mcp-cli which sends payment via PAYMENT-SIGNATURE HTTP header
 *   - Our MCP tool middleware which reads payment from args["x402-payment"]
 *
 * On MCP SDK v1 (which Apify uses: @modelcontextprotocol/sdk ^1.25.2),
 * HTTP headers are NOT accessible from tool handlers. The SDK processes
 * the JSON-RPC body and only passes {sendNotification, signal} as `extra`.
 *
 * This Express middleware sits BEFORE the MCP SDK's Streamable HTTP transport.
 * It extracts PAYMENT-SIGNATURE from the HTTP request and injects it into
 * the JSON-RPC params.arguments as "x402-payment", where the tool-level
 * middleware can read it.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  HTTP Request (from mcp-cli)                                    │
 * │    Header: PAYMENT-SIGNATURE: <base64 PaymentPayload>           │
 * │    Body: {"method":"tools/call","params":{"arguments":{...}}}   │
 * │                                                                  │
 * │  This middleware:                                                │
 * │    1. Reads PAYMENT-SIGNATURE header                            │
 * │    2. Parses JSON-RPC body                                      │
 * │    3. Injects payment into params.arguments["x402-payment"]     │
 * │    4. Passes modified body to MCP SDK                           │
 * │                                                                  │
 * │  Tool handler receives args["x402-payment"] → our middleware    │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Usage with Express:
 *   app.use('/mcp', x402TransportMiddleware);
 *   app.use('/mcp', mcpStreamableHttpHandler);
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Express middleware that extracts PAYMENT-SIGNATURE from HTTP headers
 * and injects it into the JSON-RPC body so tool handlers can access it.
 *
 * Only modifies `tools/call` requests that have a PAYMENT-SIGNATURE header.
 * All other requests pass through unmodified.
 */
export function x402TransportMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
) {
  const paymentHeader = req.headers["payment-signature"];
  if (!paymentHeader || typeof paymentHeader !== "string") {
    return next(); // No payment header — pass through
  }

  // Read the request body
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(bodyStr);

      // Only inject into tools/call requests
      if (body.method === "tools/call" && body.params?.arguments) {
        // Decode the payment header
        const decoded = Buffer.from(paymentHeader, "base64").toString("utf8");
        const paymentPayload = JSON.parse(decoded);

        // Inject into arguments so tool handler sees it as args["x402-payment"]
        body.params.arguments["x402-payment"] = paymentPayload;
      }

      // Replace the request body with the modified one
      const modified = JSON.stringify(body);
      // @ts-ignore — override the already-consumed body for downstream handlers
      req.body = body;
      req.headers["content-length"] = Buffer.byteLength(modified).toString();

      // Push the modified body back as a readable stream
      const { Readable } = require("node:stream");
      const readable = new Readable();
      readable.push(modified);
      readable.push(null);

      // Replace req's read methods
      (req as any)._readableState = readable._readableState;
      (req as any).read = readable.read.bind(readable);
      req.on = readable.on.bind(readable) as any;

      next();
    } catch {
      next(); // Parse error — pass through unmodified
    }
  });
}

/**
 * For Apify's production server (which doesn't use Express directly):
 * The same logic can be applied as a fetch wrapper or in their
 * StreamableHTTP transport configuration.
 *
 * Example with their server.ts pattern:
 *
 *   // In the CallToolRequestSchema handler, before tool lookup:
 *   const httpHeaders = getHttpHeadersFromTransport(request);
 *   if (httpHeaders?.['payment-signature']) {
 *     args['x402-payment'] = JSON.parse(
 *       Buffer.from(httpHeaders['payment-signature'], 'base64').toString()
 *     );
 *   }
 */
