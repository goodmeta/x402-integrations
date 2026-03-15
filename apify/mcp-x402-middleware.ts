/**
 * x402 MCP Payment Middleware for Apify
 *
 * Reference implementation showing how x402 up-to scheme integrates
 * at the MCP tool handler level (call-actor). Facilitator-agnostic —
 * works with any x402 facilitator that supports up-to.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  FLOW: call-actor with x402 up-to payment                      │
 * │                                                                  │
 * │  1. Agent calls call-actor(actorId, input)                      │
 * │  2. MCP server looks up Actor pricing                           │
 * │  3. No payment → return 402 with payment requirements            │
 * │  4. Has payment:                                                │
 * │     a. POST facilitator /verify → signature valid?              │
 * │     b. Run Actor → get results + actual cost                    │
 * │     c. POST facilitator /settle with actual cost                │
 * │     d. Return results + settlement receipt                      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Integration point: wraps the existing call-actor tool handler.
 * Does NOT replace your Actor execution logic — sits in front of it.
 *
 * @example
 *   // In your MCP server setup
 *   import { createX402Middleware } from './mcp-x402-middleware';
 *
 *   const x402 = createX402Middleware({
 *     facilitatorUrl: 'https://x402-facilitator.example.com',
 *     payTo: '0xYourApifyWallet',
 *     getActorPricing: async (actorId) => ({ maxAmount: '5000000', scheme: 'upto' }),
 *     getActualCost: async (runResult) => '350000',
 *   });
 *
 *   // Augment schema + wrap handler
 *   const augmented = x402.augmentSchema(callActorSchema);
 *   server.tool('call-actor', augmented, x402.wrapHandler(existingCallActorHandler));
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pricing config for an Actor. Returned by your pricing logic. */
export interface ActorPricing {
  /** Max cost in token base units. For USDC: "5000000" = $5.00. */
  maxAmount: string;
  /** Payment scheme. Use 'upto' for variable-cost Actors (most Apify use cases). */
  scheme: "upto" | "exact";
}

/** x402 payment requirements — returned to agent when no payment provided. */
export interface PaymentRequirements {
  scheme: "upto" | "exact";
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  facilitatorUrl: string;
  extra: {
    assetTransferMethod: string;
    name: string;
    version: string;
  };
}

/** Result of facilitator /verify call. */
export interface VerifyResult {
  isValid: boolean;
  payer: string;
  invalidReason: string | null;
  remainingSeconds?: number;
}

/** Result of facilitator /settle call. */
export interface SettleResult {
  success: boolean;
  payer: string;
  transaction: string;
  network: string;
  settledAmount?: string;
  errorReason?: string;
}

/** Configuration for the x402 middleware. */
export interface X402MiddlewareConfig {
  /** Facilitator URL. Any x402 facilitator that supports up-to. */
  facilitatorUrl: string;

  /** Apify's wallet address — where USDC gets paid to. */
  payTo: string;

  /** CAIP-2 network. Default: 'eip155:84532' (Base Sepolia testnet). */
  network?: string;

  /** USDC token address. Default: Base Sepolia USDC. */
  asset?: string;

  /**
   * Look up pricing for an Actor. Return null if the Actor is free.
   * This is where your existing pricing logic connects.
   *
   * @example
   *   getActorPricing: async (actorId) => {
   *     const actor = await apifyClient.actor(actorId).get();
   *     if (actor.pricingInfo?.type === 'FREE') return null;
   *     return { maxAmount: '5000000', scheme: 'upto' }; // $5 max
   *   }
   */
  getActorPricing: (actorId: string) => Promise<ActorPricing | null>;

  /**
   * Calculate actual cost after Actor run completes.
   * For up-to scheme: actual cost <= maxAmount.
   *
   * @example
   *   getActualCost: async (runResult) => {
   *     // Your existing bookkeeping already calculates this
   *     const costUsd = runResult.stats.computeUnits * COMPUTE_UNIT_PRICE;
   *     return Math.round(costUsd * 1e6).toString(); // Convert to USDC base units
   *   }
   */
  getActualCost: (runResult: any) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_NETWORK = "eip155:84532"; // Base Sepolia
const DEFAULT_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC on Base Sepolia

// For mainnet, use:
// const MAINNET_NETWORK = 'eip155:8453';
// const MAINNET_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function createX402Middleware(config: X402MiddlewareConfig) {
  const {
    facilitatorUrl,
    payTo,
    network = DEFAULT_NETWORK,
    asset = DEFAULT_ASSET,
    getActorPricing,
    getActualCost,
  } = config;

  /**
   * Build the 402 payment requirements response.
   * This is what the agent receives when payment is needed.
   */
  function buildPaymentRequired(pricing: ActorPricing): PaymentRequirements {
    return {
      scheme: pricing.scheme,
      network,
      maxAmountRequired: pricing.maxAmount,
      asset,
      payTo,
      facilitatorUrl,
      extra: {
        // Up-to scheme uses Permit2 (not ERC-2612 Permit)
        assetTransferMethod: pricing.scheme === "upto" ? "permit2" : "permit",
        name: "USDC",
        version: "2",
      },
    };
  }

  /**
   * Verify a payment signature with the facilitator.
   * The facilitator checks: valid signature, sufficient balance,
   * correct recipient, time window, Permit2 allowance.
   */
  async function verifyPayment(
    paymentPayload: any,
    paymentRequirements: PaymentRequirements
  ): Promise<VerifyResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Facilitator /verify returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Settle the actual cost with the facilitator.
   * For up-to: actualAmount can be less than maxAmount.
   * For zero-cost runs: actualAmount = "0" (no on-chain tx).
   */
  async function settlePayment(
    paymentPayload: any,
    paymentRequirements: PaymentRequirements,
    actualAmount: string
  ): Promise<SettleResult> {
    // Send same paymentPayload, but update amount to actual cost
    const settleRequirements = {
      ...paymentRequirements,
      amount: actualAmount,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000); // Longer — waits for on-chain confirmation

    try {
      const response = await fetch(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements: settleRequirements,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Facilitator /settle returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Wrap an existing MCP tool handler with x402 payment gating.
   *
   * The wrapper intercepts call-actor calls and:
   * 1. Checks if the Actor needs payment
   * 2. If no payment provided → returns payment requirements
   * 3. If payment provided → verify → execute → settle → return results
   *
   * @param handler - Your existing call-actor handler function
   * @returns Wrapped handler with x402 payment flow
   */
  function wrapHandler(
    handler: (args: any) => Promise<any>
  ): (args: any, extra: any) => Promise<any> {
    return async (args: any, extra: any) => {
      const actorId = args.actorId || args.actor_id || args.id;

      // Step 1: Check if this Actor requires payment
      const pricing = await getActorPricing(actorId);
      if (!pricing) {
        // Free Actor — pass through directly
        return handler(args);
      }

      // Step 2: Check for payment in the request
      //
      // Primary: Skyfire-style tool argument — args["x402-payment"]
      //   Works on MCP SDK v1 (Apify uses ^1.25.2) across all transports.
      //   Same pattern as Apify's existing skyfire-pay-id integration.
      //
      // Fallback: x402 MCP transport spec — params._meta["x402/payment"]
      //   Spec-compliant path (specs/transports-v2/mcp.md).
      //   Requires SDK v2+ or server passing params._meta to handler.
      //   On SDK v1: extra only has {sendNotification, signal}, so
      //   _meta and requestInfo are not available in tool handlers.
      //
      // Note: Apify's mcp-cli sends payment via PAYMENT-SIGNATURE HTTP header.
      //   On SDK v1, HTTP headers are NOT accessible from tool handlers.
      //   To support mcp-cli's header-based flow, Apify would need HTTP
      //   transport middleware that extracts the header and injects it into
      //   args["x402-payment"] before MCP processes the request.
      //   See example-transport-middleware.ts for a reference.
      const paymentPayload =
        args["x402-payment"] ||
        extra?._meta?.["x402/payment"] ||
        extra?.mcpReq?._meta?.["x402/payment"];

      if (!paymentPayload) {
        // No payment → return 402 with payment requirements.
        // Format follows x402 MCP transport spec (specs/transports-v2/mcp.md):
        //   - structuredContent: PaymentRequired object (for x402 client libraries)
        //   - content[0].text: JSON string of same (for LLMs that parse text)
        //   - isError: true (signals the LLM to take action)
        const requirements = buildPaymentRequired(pricing);

        // x402 spec PaymentRequired format
        const paymentRequired = {
          x402Version: 2,
          error: `This Actor costs up to $${(parseInt(pricing.maxAmount) / 1e6).toFixed(2)} USDC. ` +
            `Provide payment via x402-payment argument or _meta["x402/payment"].`,
          resource: {
            url: `mcp://tool/call-actor/${actorId}`,
            description: `Apify Actor: ${actorId}`,
          },
          accepts: [requirements],
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(paymentRequired, null, 2),
            },
          ],
          structuredContent: paymentRequired,
          isError: true,
        };
      }

      // Step 3: Parse payment payload
      // If it came as a base64 string (from HTTP header), decode it
      let parsedPayment: any;
      if (typeof paymentPayload === "string") {
        try {
          const decoded = Buffer.from(paymentPayload, "base64").toString("utf8");
          parsedPayment = JSON.parse(decoded);
        } catch {
          // Try as raw JSON string
          try {
            parsedPayment = JSON.parse(paymentPayload);
          } catch {
            return {
              content: [{ type: "text", text: "Invalid x402 payment format" }],
              isError: true,
            };
          }
        }
      } else {
        parsedPayment = paymentPayload;
      }

      const requirements = buildPaymentRequired(pricing);

      // Step 4: Verify payment with facilitator
      let verifyResult: VerifyResult;
      try {
        verifyResult = await verifyPayment(parsedPayment, requirements);
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Payment verification failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      if (!verifyResult.isValid) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  paymentInvalid: true,
                  reason: verifyResult.invalidReason,
                  payer: verifyResult.payer,
                  message:
                    "Payment signature is invalid. Check balance, allowance, and deadline.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      // Step 5: Payment verified — execute the Actor
      // Strip payment fields before forwarding — same as Skyfire strips 'skyfire-pay-id'.
      // The Actor handler should not see payment data in its arguments.
      const { "x402-payment": _payment, _x402Payment: _paymentLegacy, ...actorArgs } = args;

      let runResult: any;
      try {
        runResult = await handler(actorArgs);
      } catch (error: any) {
        // Actor failed — settle for zero (agent isn't charged for failed runs)
        try {
          await settlePayment(parsedPayment, requirements, "0");
        } catch {
          // Settlement failure on zero amount is non-critical
        }

        return {
          content: [
            {
              type: "text",
              text: `Actor execution failed: ${error.message}. No charge.`,
            },
          ],
          isError: true,
        };
      }

      // Step 6: Calculate actual cost and validate against signed max
      const actualCost = await getActualCost(runResult);
      if (BigInt(actualCost) > BigInt(pricing.maxAmount)) {
        console.error(
          `[x402] Actual cost ${actualCost} exceeds signed max ${pricing.maxAmount} for Actor ${actorId}. ` +
          `Settling for max amount instead.`
        );
        // Don't fail — settle for the max the agent authorized
      }
      const settlementAmount = BigInt(actualCost) > BigInt(pricing.maxAmount)
        ? pricing.maxAmount
        : actualCost;

      // Step 7: Settle with facilitator
      let settleResult: SettleResult;
      try {
        settleResult = await settlePayment(
          parsedPayment,
          requirements,
          settlementAmount
        );
      } catch (error: any) {
        // Settlement failed but Actor already ran.
        // Log for manual resolution — don't fail the response.
        console.error(
          `[x402] Settlement failed for Actor ${actorId}, ` +
            `payer ${verifyResult.payer}, amount ${settlementAmount}: ${error.message}`
        );

        // Return results anyway — the Actor already executed.
        // Your billing team handles unresolved settlements.
        // Use _meta for protocol-level metadata (MCP spec compliant).
        const failContent = Array.isArray(runResult.content) ? runResult.content : [];
        return {
          content: failContent,
          _meta: {
            "x402/payment-response": {
              settled: false,
              error: error.message,
              actualCost: settlementAmount,
              payer: verifyResult.payer,
            },
          },
        };
      }

      // Step 8: Check settlement result
      // The facilitator returns 200 even for logical failures
      // (e.g. nonce_already_settled, amount_exceeds_permitted).
      // Must check settleResult.success, not just HTTP status.
      if (!settleResult.success) {
        console.error(
          `[x402] Settlement rejected for Actor ${actorId}, ` +
            `payer ${verifyResult.payer}: ${settleResult.errorReason}`
        );
        const failContent = Array.isArray(runResult.content) ? runResult.content : [];
        return {
          content: failContent,
          _meta: {
            "x402/payment-response": {
              settled: false,
              error: settleResult.errorReason,
              actualCost: settlementAmount,
              payer: verifyResult.payer,
            },
          },
        };
      }

      // Step 9: Return results with settlement receipt
      // Settlement info goes in _meta (MCP-compliant metadata),
      // not as a top-level field that the SDK would strip.
      const resultContent = Array.isArray(runResult.content) ? runResult.content : [];
      return {
        content: resultContent,
        _meta: {
          "x402/payment-response": {
            settled: true,
            transaction: settleResult.transaction,
            settledAmount: settleResult.settledAmount,
            payer: settleResult.payer,
            network: settleResult.network,
          },
        },
      };
    };
  }

  /**
   * Augment a tool's inputSchema to include the x402-payment field.
   * Same pattern as Apify's applySkyfireAugmentation() adds 'skyfire-pay-id'.
   *
   * Without this, the LLM doesn't know the x402-payment argument exists
   * and will never pass it. The schema tells the LLM:
   * "this tool accepts an optional payment object."
   *
   * @param schema - The tool's existing inputSchema (JSON Schema object)
   * @returns Augmented schema with x402-payment field added
   *
   * @example
   *   const augmentedSchema = x402.augmentSchema(callActorSchema);
   *   server.tool('call-actor', augmentedSchema, x402.wrapHandler(handler));
   */
  function augmentSchema(schema: Record<string, any>): Record<string, any> {
    return {
      ...schema,
      properties: {
        ...(schema.properties || {}),
        "x402-payment": {
          type: "object",
          description:
            "x402 payment authorization. Required for paid Actors. " +
            "If omitted, the tool returns payment requirements (scheme, amount, facilitator). " +
            "The agent's x402 client signs a Permit2 authorization and passes it here on retry.",
          properties: {
            x402Version: { type: "number" },
            accepted: {
              type: "object",
              properties: {
                scheme: { type: "string", enum: ["upto", "exact"] },
                network: { type: "string" },
              },
            },
            payload: {
              type: "object",
              description: "Signed payment payload (signature, permit, witness)",
            },
          },
        },
      },
    };
  }

  return {
    wrapHandler,
    augmentSchema,
    verifyPayment,
    settlePayment,
    buildPaymentRequired,
  };
}
