/**
 * Example: Integrating x402 payment into Apify's MCP call-actor
 *
 * This shows how the middleware from mcp-x402-middleware.ts plugs into
 * your existing MCP server. It does NOT replace your Actor execution —
 * it wraps the payment flow around it.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  WHAT CHANGES IN YOUR CODEBASE                                  │
 * │                                                                  │
 * │  1. Import the middleware                               (1 line) │
 * │  2. Configure it with your pricing + facilitator        (15 lines)│
 * │  3. Augment tool schema + wrap handler                  (2 lines)│
 * │                                                                  │
 * │  Your Actor execution logic, bookkeeping, and pricing            │
 * │  calculation stay exactly the same. No blockchain code needed.   │
 * └──────────────────────────────────────────────────────────────────┘
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createX402Middleware, type ActorPricing } from "./mcp-x402-middleware";

// ---------------------------------------------------------------------------
// 1. Configure the middleware
// ---------------------------------------------------------------------------

const x402 = createX402Middleware({
  // Any x402 facilitator that supports up-to scheme.
  // Swap this URL to switch facilitators — no code changes needed.
  facilitatorUrl: "https://x402-facilitator.example.com",

  // Your Apify wallet — where USDC gets paid to
  payTo: "0xYourApifyWalletAddress",

  // Base Sepolia for testnet, switch to mainnet for production:
  // network: 'eip155:8453',
  // asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",

  // Connect to your existing Actor pricing logic.
  // Return null for free Actors — they skip payment entirely.
  getActorPricing: async (actorId: string): Promise<ActorPricing | null> => {
    // Your pricing API/database already knows this.
    // This is just a lookup — no new logic needed.
    const actorInfo = await getActorInfo(actorId); // your existing function

    if (actorInfo.pricingModel === "FREE" || actorInfo.pricingModel === "COMPUTE_ONLY") {
      return null; // No x402 payment required
    }

    // For pay-per-event or pay-per-result Actors:
    // Set maxAmount to the Actor's advertised max cost.
    // The agent authorizes up to this amount. You settle actual usage.
    return {
      maxAmount: actorInfo.maxCostUsdcBaseUnits, // e.g. "5000000" = $5.00
      scheme: "upto", // Always upto for Apify — cost is variable
    };
  },

  // Calculate actual cost after Actor run completes.
  // Your bookkeeping already does this for Skyfire — same logic.
  getActualCost: async (runResult: any): Promise<string> => {
    // runResult is whatever your existing handler returns.
    // Extract the actual cost from your run stats.
    const stats = runResult._runStats; // your stats object
    const costUsd = stats.totalCostUsd; // e.g. 0.35

    // Convert to USDC base units (6 decimals)
    return Math.round(costUsd * 1e6).toString(); // "350000" = $0.35
  },
});

// ---------------------------------------------------------------------------
// 2. Your existing call-actor handler (unchanged)
// ---------------------------------------------------------------------------

/**
 * This is your existing Actor execution logic.
 * It stays exactly the same — the middleware wraps around it.
 */
async function existingCallActorHandler(args: any): Promise<any> {
  const { actorId, input, build, memory, timeout } = args;

  // Your existing code: start Actor run, wait for results, etc.
  // const run = await apifyClient.actor(actorId).call(input, { build, memory, timeout });
  // const dataset = await apifyClient.dataset(run.defaultDatasetId).listItems();

  // Simulated for this example:
  const run = {
    id: "run_abc123",
    actorId,
    status: "SUCCEEDED",
    defaultDatasetId: "ds_xyz789",
    stats: { computeUnits: 0.5, durationSecs: 12.3 },
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          runId: run.id,
          status: run.status,
          items: [
            /* ...dataset items... */
          ],
        }),
      },
    ],
    // Pass stats through so getActualCost can access them
    _runStats: { totalCostUsd: 0.35 },
  };
}

// ---------------------------------------------------------------------------
// 3. Wire it up in your MCP server
// ---------------------------------------------------------------------------

// Apify uses setRequestHandler + custom tool map, not server.tool().
// The patterns below show both approaches.

// Option A: If using server.tool() (standard MCP SDK pattern):
//   const augmentedSchema = x402.augmentSchema(callActorSchema);
//   server.tool('call-actor', augmentedSchema, x402.wrapHandler(existingCallActorHandler));

// Option B: Apify's actual pattern (setRequestHandler + upsertTools):
//   In upsertTools(), apply augmentation to the tool's inputSchema:
//     tool.inputSchema = x402.augmentSchema(tool.inputSchema);
//   In the CallToolRequestSchema handler, wrap the tool execution:
//     const result = await x402.wrapHandler(tool.call)(args, extra);
//
// augmentSchema: adds 'x402-payment' to inputSchema.properties
//   (same as applySkyfireAugmentation adds 'skyfire-pay-id')
// wrapHandler: validates payment, strips before forwarding, settles after execution
//
// Note: Apify's AJV validators use additionalProperties: true,
// so 'x402-payment' passes validation without schema changes to the validator.

const server = new (await import("@modelcontextprotocol/sdk/server/index.js")).Server(
  { name: "apify-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// What the agent sees
// ---------------------------------------------------------------------------

/**
 * SCENARIO 1: Agent calls call-actor without payment
 *
 * Agent sends:
 *   { tool: 'call-actor', arguments: { actorId: 'apify/web-scraper', input: {...} } }
 *
 * Agent receives:
 *   {
 *     "paymentRequired": true,
 *     "actorId": "apify/web-scraper",
 *     "requirements": {
 *       "scheme": "upto",
 *       "network": "eip155:84532",
 *       "maxAmountRequired": "5000000",
 *       "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
 *       "payTo": "0xYourApifyWalletAddress",
 *       "facilitatorUrl": "https://x402-facilitator.example.com",
 *       "extra": {
 *         "assetTransferMethod": "permit2",
 *         "name": "USDC",
 *         "version": "2"
 *       }
 *     },
 *     "message": "This Actor costs up to $5.00 USDC. Sign a payment authorization and re-call with x402-payment argument."
 *   }
 *
 *
 * SCENARIO 2: Agent re-calls with payment (x402 client library handles this)
 *
 * Agent sends:
 *   {
 *     tool: 'call-actor',
 *     arguments: {
 *       actorId: 'apify/web-scraper',
 *       input: {...},
 *       "x402-payment": {
 *         x402Version: 2,
 *         accepted: { scheme: 'upto', network: 'eip155:84532' },
 *         payload: {
 *           signature: '0x...',
 *           owner: '0xAgentWallet',
 *           permit: {
 *             permitted: { token: '0x...USDC', amount: '5000000' },
 *             nonce: '123456',
 *             deadline: '1710086400'
 *           },
 *           witness: {
 *             to: '0xApifyWallet',
 *             facilitator: '0xFacilitatorSigner',
 *             validAfter: '0'
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Agent receives (success):
 *   {
 *     "content": [{ "type": "text", "text": "{\"runId\":\"run_abc123\",...}" }],
 *     "_meta": {
 *       "x402": {
 *         "settled": true,
 *         "transaction": "0x...txhash",
 *         "settledAmount": "350000",  // $0.35 — actual cost, not the $5 max
 *         "payer": "0xAgentWallet",
 *         "network": "eip155:84532"
 *       }
 *     }
 *   }
 *
 *
 * SCENARIO 3: Actor fails — agent gets zero-charge settlement
 *
 *   The middleware settles for $0. The agent's wallet is not charged.
 *   The nonce is consumed (prevents replay) but no USDC moves on-chain.
 */

// ---------------------------------------------------------------------------
// Pricing examples for different Actor types
// ---------------------------------------------------------------------------

/**
 * How getActorPricing maps to Apify's pricing models:
 *
 * PAY_PER_EVENT Actors:
 *   maxAmount = max_events * price_per_event
 *   scheme = 'upto'
 *   actual cost = events_emitted * price_per_event
 *
 * PAY_PER_RESULT Actors (merging into pay-per-event):
 *   maxAmount = estimated_max_results * price_per_result
 *   scheme = 'upto'
 *   actual cost = results_returned * price_per_result
 *
 * COMPUTE_ONLY Actors (free, pay for platform):
 *   return null — no x402 payment
 *
 * RENTAL Actors (legacy, being deprecated):
 *   Not supported by x402 — monthly subscription doesn't map to per-request
 */

// ---------------------------------------------------------------------------
// Helper stubs (replace with your actual implementations)
// ---------------------------------------------------------------------------

async function getActorInfo(actorId: string) {
  // Stub — replace with your actual Actor info lookup
  return {
    pricingModel: "PAY_PER_EVENT" as const,
    maxCostUsdcBaseUnits: "5000000", // $5.00
  };
}

export { x402, existingCallActorHandler };
