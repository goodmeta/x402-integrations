/**
 * Test: x402 MCP middleware for Apify call-actor
 *
 * Spins up a mock facilitator, then exercises the full flow:
 *   1. Call without payment → get 402 requirements
 *   2. Call with valid payment → verify → execute → settle → results
 *   3. Call with invalid payment → rejection
 *   4. Actor failure → zero-cost settlement
 *   5. Free Actor → no payment flow
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createX402Middleware, type ActorPricing } from "./mcp-x402-middleware.js";

// ---------------------------------------------------------------------------
// Mock facilitator server
// ---------------------------------------------------------------------------

const MOCK_FACILITATOR_PORT = 19402;
const MOCK_TX_HASH = "0xabc123def456789abc123def456789abc123def456789abc123def456789abcd";

function startMockFacilitator(): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      res.setHeader("Content-Type", "application/json");

      if (req.url === "/verify") {
        const scheme = body.paymentPayload?.accepted?.scheme;
        const signature = body.paymentPayload?.payload?.signature;

        if (scheme !== "upto") {
          res.end(JSON.stringify({ isValid: false, payer: "unknown", invalidReason: "unsupported_scheme" }));
          return;
        }

        // Simulate invalid signature check
        if (signature === "0xINVALID") {
          res.end(JSON.stringify({
            isValid: false,
            payer: body.paymentPayload.payload.owner,
            invalidReason: "invalid_upto_evm_payload_signature",
          }));
          return;
        }

        res.end(JSON.stringify({
          isValid: true,
          payer: body.paymentPayload.payload.owner,
          invalidReason: null,
          remainingSeconds: 300,
        }));
        return;
      }

      if (req.url === "/settle") {
        const actualAmount = body.paymentRequirements?.amount || "0";
        const signature = body.paymentPayload?.payload?.signature;

        // Simulate settlement rejection (nonce replay, etc.)
        if (signature === "0xSETTLE_FAIL") {
          res.end(JSON.stringify({
            success: false,
            payer: body.paymentPayload.payload.owner,
            transaction: "",
            network: body.paymentPayload.accepted.network,
            errorReason: "nonce_already_settled",
          }));
          return;
        }

        res.end(JSON.stringify({
          success: true,
          payer: body.paymentPayload.payload.owner,
          transaction: actualAmount === "0" ? "" : MOCK_TX_HASH,
          network: body.paymentPayload.accepted.network,
          settledAmount: actualAmount,
        }));
        return;
      }

      res.statusCode = 404;
      res.end("Not found");
    });

    server.listen(MOCK_FACILITATOR_PORT, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePaymentPayload(overrides: Record<string, any> = {}) {
  return {
    x402Version: 2,
    accepted: { scheme: "upto", network: "eip155:84532" },
    payload: {
      signature: "0xVALIDSIGNATURE",
      owner: "0xAgentWallet1234567890abcdef1234567890abcdef",
      permit: {
        permitted: {
          token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "5000000",
        },
        nonce: "12345",
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
      },
      witness: {
        to: "0xApifyWallet1234567890abcdef1234567890abcdef",
        facilitator: "0xFacilitator1234567890abcdef1234567890abcde",
        validAfter: "0",
      },
      ...overrides,
    },
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.log(`  ✗ ${testName}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("Starting mock facilitator...");
  const mockServer = await startMockFacilitator();
  console.log(`Mock facilitator running on port ${MOCK_FACILITATOR_PORT}\n`);

  // Create middleware
  const x402 = createX402Middleware({
    facilitatorUrl: `http://localhost:${MOCK_FACILITATOR_PORT}`,
    payTo: "0xApifyWallet1234567890abcdef1234567890abcdef",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",

    getActorPricing: async (actorId: string): Promise<ActorPricing | null> => {
      if (actorId === "apify/free-actor") return null;
      return { maxAmount: "5000000", scheme: "upto" };
    },

    getActualCost: async (runResult: any): Promise<string> => {
      return runResult._runStats?.totalCostUsdc || "350000"; // $0.35 default
    },
  });

  // Mock Actor handler — also checks that payment args are stripped
  let actorShouldFail = false;
  let lastActorArgs: any = null;
  const mockActorHandler = async (args: any) => {
    lastActorArgs = args;
    if (actorShouldFail) throw new Error("Actor timeout");
    return {
      content: [{ type: "text", text: JSON.stringify({ runId: "run_123", items: [{ url: "https://example.com", title: "Test" }] }) }],
      _runStats: { totalCostUsdc: "350000" },
    };
  };

  const wrappedHandler = x402.wrapHandler(mockActorHandler);

  // -----------------------------------------------------------------------
  // Test 1: No payment → 402 with requirements
  // -----------------------------------------------------------------------
  console.log("Test 1: call-actor without payment → 402 response");
  {
    const result = await wrappedHandler(
      { actorId: "apify/web-scraper", input: { url: "https://example.com" } },
      {}
    );

    assert(result.isError === true, "isError is true");

    // x402 MCP spec: structuredContent has PaymentRequired object
    assert(result.structuredContent?.x402Version === 2, "structuredContent has x402Version: 2");
    assert(Array.isArray(result.structuredContent?.accepts), "structuredContent has accepts array");
    assert(result.structuredContent?.resource?.url?.includes("apify/web-scraper"), "resource URL has actorId");

    // x402 MCP spec: content[0].text has JSON string of same
    const body = JSON.parse(result.content[0].text);
    assert(body.x402Version === 2, "x402Version is 2");
    assert(body.accepts[0].scheme === "upto", "scheme is upto");
    assert(body.accepts[0].network === "eip155:84532", "network is Base Sepolia");
    assert(body.accepts[0].maxAmountRequired === "5000000", "maxAmount is $5.00");
    assert(body.accepts[0].payTo === "0xApifyWallet1234567890abcdef1234567890abcdef", "payTo matches");
    assert(body.accepts[0].facilitatorUrl.includes("19402"), "facilitatorUrl present");
    assert(body.accepts[0].extra.assetTransferMethod === "permit2", "up-to uses permit2");
    assert(body.error.includes("$5.00"), "error message shows cost");
  }

  // -----------------------------------------------------------------------
  // Test 2: Valid payment → verify → execute → settle → results
  // -----------------------------------------------------------------------
  console.log("\nTest 2: call-actor with valid payment → full flow");
  {
    const result = await wrappedHandler(
      {
        actorId: "apify/web-scraper",
        input: { url: "https://example.com" },
        "x402-payment": makePaymentPayload(),
      },
      {}
    );

    assert(result.isError !== true, "no error");
    assert(result._meta?.["x402/payment-response"]?.settled === true, "settled is true");
    assert(result._meta?.["x402/payment-response"]?.transaction === MOCK_TX_HASH, "transaction hash present");
    assert(result._meta?.["x402/payment-response"]?.settledAmount === "350000", "settled $0.35 (actual cost, not $5 max)");
    assert(result._meta?.["x402/payment-response"]?.payer.startsWith("0x"), "payer address present");
    assert(result._meta?.["x402/payment-response"]?.network === "eip155:84532", "network in receipt");

    const content = JSON.parse(result.content[0].text);
    assert(content.runId === "run_123", "Actor results returned");
    assert(content.items.length === 1, "Actor data present");

    // Verify payment args were stripped before reaching Actor handler
    assert(!("x402-payment" in lastActorArgs), "x402-payment stripped from Actor args");
    assert(!("_x402Payment" in lastActorArgs), "_x402Payment stripped from Actor args");
    assert("actorId" in lastActorArgs, "actorId still in Actor args");
    assert("input" in lastActorArgs, "input still in Actor args");
  }

  // -----------------------------------------------------------------------
  // Test 3: Invalid payment signature → rejection
  // -----------------------------------------------------------------------
  console.log("\nTest 3: call-actor with invalid signature → rejected");
  {
    const result = await wrappedHandler(
      {
        actorId: "apify/web-scraper",
        input: { url: "https://example.com" },
        "x402-payment": makePaymentPayload({ signature: "0xINVALID" }),
      },
      {}
    );

    assert(result.isError === true, "isError is true");

    const body = JSON.parse(result.content[0].text);
    assert(body.paymentInvalid === true, "paymentInvalid flag set");
    assert(body.reason === "invalid_upto_evm_payload_signature", "invalid signature reason");
  }

  // -----------------------------------------------------------------------
  // Test 4: Actor failure → zero-cost settlement
  // -----------------------------------------------------------------------
  console.log("\nTest 4: Actor fails → zero-cost settlement (agent not charged)");
  {
    actorShouldFail = true;
    const result = await wrappedHandler(
      {
        actorId: "apify/web-scraper",
        input: { url: "https://example.com" },
        "x402-payment": makePaymentPayload(),
      },
      {}
    );
    actorShouldFail = false;

    assert(result.isError === true, "isError is true");
    assert(result.content[0].text.includes("No charge"), "no charge message");
  }

  // -----------------------------------------------------------------------
  // Test 5: Free Actor → no payment flow
  // -----------------------------------------------------------------------
  console.log("\nTest 5: Free Actor → skips payment entirely");
  {
    const result = await wrappedHandler(
      { actorId: "apify/free-actor", input: {} },
      {}
    );

    assert(result.isError !== true, "no error");
    assert(result._meta?.x402 === undefined, "no x402 receipt (free)");

    const content = JSON.parse(result.content[0].text);
    assert(content.runId === "run_123", "Actor results returned directly");
  }

  // -----------------------------------------------------------------------
  // Test 6: Payment via _meta["x402/payment"] (x402 MCP transport spec)
  //
  // This is the spec-compliant path (specs/transports-v2/mcp.md).
  // Requires MCP SDK v2+ or server passing params._meta to handler.
  // On Apify's SDK v1 (^1.25.2), this path is NOT available natively —
  // _meta would need to be passed explicitly by the server.
  // -----------------------------------------------------------------------
  console.log("\nTest 6: Payment via _meta['x402/payment'] (x402 MCP spec, SDK v2+)");
  {
    const result = await wrappedHandler(
      { actorId: "apify/web-scraper", input: {} },
      { _meta: { "x402/payment": makePaymentPayload() } }
    );

    assert(result.isError !== true, "no error");
    assert(result._meta?.["x402/payment-response"]?.settled === true, "settled via _meta spec pattern");
    assert(result._meta?.["x402/payment-response"]?.settledAmount === "350000", "correct amount");
  }

  // -----------------------------------------------------------------------
  // Test 7: Payment injected by transport middleware (mcp-cli compat)
  //
  // Apify's mcp-cli sends payment via PAYMENT-SIGNATURE HTTP header.
  // On SDK v1, HTTP headers aren't accessible in tool handlers.
  // The transport middleware (example-transport-middleware.ts) extracts
  // the header and injects it into args["x402-payment"] before the
  // tool handler runs. This test simulates that injection.
  // -----------------------------------------------------------------------
  console.log("\nTest 7: Payment injected by transport middleware (mcp-cli compat)");
  {
    // Simulate: transport middleware decoded PAYMENT-SIGNATURE header
    // and injected it as args["x402-payment"]
    const paymentObj = makePaymentPayload();
    const result = await wrappedHandler(
      {
        actorId: "apify/web-scraper",
        input: {},
        "x402-payment": paymentObj, // injected by transport middleware
      },
      { sendNotification: async () => {}, signal: new AbortController().signal } // SDK v1 extra shape
    );

    assert(result.isError !== true, "no error");
    assert(result._meta?.["x402/payment-response"]?.settled === true, "settled via injected payment");
    assert(result._meta?.["x402/payment-response"]?.settledAmount === "350000", "correct amount");
  }

  // -----------------------------------------------------------------------
  // Test 8: Settlement logical failure (200 but success: false)
  // -----------------------------------------------------------------------
  console.log("\nTest 8: Settlement returns success:false → not marked as settled");
  {
    const result = await wrappedHandler(
      {
        actorId: "apify/web-scraper",
        input: {},
        "x402-payment": makePaymentPayload({ signature: "0xSETTLE_FAIL" }),
      },
      {}
    );

    // Actor ran (results returned) but settlement failed
    assert(result._meta?.["x402/payment-response"]?.settled === false, "settled is false");
    assert(result._meta?.["x402/payment-response"]?.error === "nonce_already_settled", "error reason present");
    assert(result.content !== undefined, "Actor results still returned");
  }

  // -----------------------------------------------------------------------
  // Test 9: Schema augmentation adds x402-payment field
  // -----------------------------------------------------------------------
  console.log("\nTest 9: augmentSchema adds x402-payment to tool inputSchema");
  {
    const originalSchema = {
      type: "object",
      properties: {
        actorId: { type: "string", description: "Actor ID" },
        input: { type: "object", description: "Actor input" },
      },
      required: ["actorId"],
    };

    const augmented = x402.augmentSchema(originalSchema);

    assert("x402-payment" in augmented.properties, "x402-payment field added");
    assert(augmented.properties["x402-payment"].type === "object", "x402-payment is object type");
    assert(augmented.properties["x402-payment"].description?.includes("x402"), "has description");
    assert(augmented.properties.actorId.type === "string", "original fields preserved");
    assert(augmented.properties.input.type === "object", "original fields preserved");
    assert(augmented.required?.[0] === "actorId", "required array preserved");
    // x402-payment should NOT be required — it's optional (free Actors skip it)
    assert(!augmented.required?.includes("x402-payment"), "x402-payment not required");
  }

  // -----------------------------------------------------------------------
  // Results
  // -----------------------------------------------------------------------
  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}`);

  mockServer.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
