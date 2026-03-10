/**
 * Tavily Search — x402 v1 integration example
 *
 * This example shows how to gate any API behind x402 micropayments.
 * An AI agent that wants search results must pay a small amount of USDC
 * (a stablecoin pegged to $1 USD) before getting access.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  HOW x402 WORKS (simplified)                                      │
 * │                                                                    │
 * │  1. Agent calls POST /search without payment                      │
 * │  2. Server responds HTTP 402 "Payment Required" with price info   │
 * │  3. Agent signs a payment authorization off-chain (no gas needed)  │
 * │  4. Agent retries the request with payment in the X-PAYMENT header│
 * │  5. Server verifies payment via a "facilitator" (a trusted        │
 * │     third-party service that checks the signature is valid)       │
 * │  6. If valid, server calls Tavily and returns real results        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * This is an x402 v1 example:
 * - Uses the X-PAYMENT header (v1 convention)
 * - Returns x402Version: 1 in the 402 response
 * - Verify-only — does NOT settle (execute) the payment on-chain
 *   (in v1, the facilitator just checks the signature is valid but
 *    doesn't actually move tokens. v2 adds a settle step for that.)
 *
 * Runs on Cloudflare Workers.
 */

import { tavilySearch } from "./tavily";

// ---------------------------------------------------------------------------
// Config — set via Cloudflare Worker environment variables
// ---------------------------------------------------------------------------

interface Env {
  /** Your Tavily API key (the upstream service we're wrapping) */
  TAVILY_API_KEY: string;

  /**
   * URL of the x402 facilitator service.
   * The facilitator is a trusted third party that verifies payment signatures.
   * Think of it like a payment processor — it checks that the agent's
   * cryptographic signature authorizes the right amount to the right wallet.
   *
   * Examples:
   *   - Coinbase:  https://x402.coinbase.com
   *   - SBC:       https://x402.stablecoin.xyz
   */
  FACILITATOR_URL: string;

  /**
   * Your wallet address — where payments are sent.
   * This is a standard Ethereum/Base address (0x...).
   */
  PAY_TO: string;

  /**
   * Price per request in USDC base units.
   * USDC has 6 decimal places, so:
   *   "1000"    = 0.001 USDC ($0.001)
   *   "10000"   = 0.01  USDC ($0.01)
   *   "1000000" = 1.00  USDC ($1.00)
   */
  AMOUNT_REQUIRED: string;
}

/**
 * USDC contract address on Base mainnet.
 * USDC is a stablecoin (1 USDC = $1 USD) issued by Circle.
 * This is the specific smart contract on the Base L2 network.
 *
 * Each blockchain network has its own USDC contract address.
 * Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * CAIP-2 network identifier for Base mainnet.
 * CAIP-2 is a standard way to identify blockchain networks:
 *   "eip155" = Ethereum-compatible chain
 *   "8453"   = Base mainnet chain ID
 *
 * Other common CAIP-2 IDs:
 *   "eip155:1"     = Ethereum mainnet
 *   "eip155:84532" = Base Sepolia (testnet)
 */
const BASE_NETWORK = "eip155:8453";

// ---------------------------------------------------------------------------
// Payment requirement builder
// ---------------------------------------------------------------------------

/**
 * Builds the payment requirements object that tells AI agents:
 * "Here's what you need to pay, how much, and to whom."
 *
 * This is returned in the 402 response body so the agent knows
 * exactly what payment to construct.
 */
function buildPaymentRequirements(url: string, env: Env) {
  return {
    /** Payment scheme — "exact" means the agent pays the exact amount listed */
    scheme: "exact",

    /** Which blockchain network to pay on (Base mainnet) */
    network: BASE_NETWORK,

    /** Price in token base units (e.g., "1000" = 0.001 USDC) */
    maxAmountRequired: env.AMOUNT_REQUIRED,

    /** The API endpoint being paid for — lets the agent verify it's paying for the right thing */
    resource: url,

    /** Human-readable description shown to the agent (or its operator) */
    description: "Tavily web search — results for one query",

    /** Response content type */
    mimeType: "application/json",

    /** Merchant wallet address that will receive the payment */
    payTo: env.PAY_TO,

    /** How long (in seconds) the payment authorization stays valid. 300 = 5 minutes */
    maxTimeoutSeconds: 300,

    /** The token contract address to pay with (USDC on Base) */
    asset: USDC_BASE,

    /**
     * EIP-712 domain info for the token.
     * EIP-712 is a standard for signing structured data — it's what makes
     * the "sign without gas" magic work. The name and version must match
     * what's hardcoded in the USDC smart contract.
     *
     * For USDC on Base: name = "USD Coin", version = "2"
     */
    extra: {
      name: "USD Coin",
      version: "2",
    },
  };
}

// ---------------------------------------------------------------------------
// Facilitator verification
// ---------------------------------------------------------------------------

/** Response from the facilitator's /verify endpoint */
interface VerifyResponse {
  /** Whether the payment signature is valid and covers the required amount */
  isValid: boolean;
  /** The wallet address of the payer (extracted from the signature) */
  payer: string | null;
  /** Why verification failed, if it did */
  invalidReason: string | null;
}

/**
 * Sends the agent's payment payload to the facilitator for verification.
 *
 * The facilitator checks:
 * 1. The signature is cryptographically valid
 * 2. The payment amount matches what we require
 * 3. The payment is made to our wallet address
 * 4. The payment hasn't expired
 * 5. The payer actually has enough tokens
 *
 * In v1, this is verify-only — no tokens are actually transferred.
 * The facilitator just confirms "yes, this payment authorization is legit."
 */
async function verifyPayment(
  facilitatorUrl: string,
  paymentPayload: unknown,
  paymentRequirements: unknown
): Promise<VerifyResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, "")}/verify`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Facilitator returned ${response.status}: ${text}`);
  }

  return response.json() as Promise<VerifyResponse>;
}

// ---------------------------------------------------------------------------
// 402 response
// ---------------------------------------------------------------------------

/**
 * Returns an HTTP 402 "Payment Required" response.
 *
 * This is the x402 v1 format:
 * - x402Version: 1  (tells the agent which protocol version to use)
 * - accepts: [...]   (array of accepted payment methods — usually just one)
 * - X-Payment-Version header for backwards compatibility
 *
 * In v2, this changes to:
 * - x402Version: 2
 * - PAYMENT-REQUIRED header (base64-encoded requirements)
 * - PAYMENT-SIGNATURE header instead of X-PAYMENT
 */
function paymentRequiredResponse(paymentRequirements: unknown): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      error: "Payment Required",
      accepts: [paymentRequirements],
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Version": "1",
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Worker handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — useful for uptime monitoring, not payment-gated
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only handle /search — return 404 for everything else
    if (url.pathname !== "/search") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST required" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const paymentRequirements = buildPaymentRequirements(request.url, env);

    // -----------------------------------------------------------------------
    // Step 1: Check for the X-PAYMENT header
    //
    // x402 v1 uses X-PAYMENT. The agent sends its payment authorization
    // as a base64-encoded JSON string in this header.
    //
    // If the header is missing, the agent hasn't paid yet — return 402
    // with payment instructions so it knows what to do.
    // -----------------------------------------------------------------------
    const paymentHeader = request.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return paymentRequiredResponse(paymentRequirements);
    }

    // -----------------------------------------------------------------------
    // Step 2: Decode the payment payload from base64 JSON
    //
    // The agent encodes its payment as: base64(JSON.stringify(paymentData))
    // We decode it back to get the signature and authorization details.
    // -----------------------------------------------------------------------
    let paymentPayload: unknown;
    try {
      paymentPayload = JSON.parse(atob(paymentHeader));
    } catch {
      return new Response(
        JSON.stringify({ error: "X-PAYMENT header is not valid base64-encoded JSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // -----------------------------------------------------------------------
    // Step 3: Verify with the facilitator
    //
    // We send both the agent's payment and our requirements to the
    // facilitator. It cryptographically verifies the signature matches
    // and the payment covers what we asked for.
    //
    // Note: In v1, this is verify-only. No tokens move on-chain.
    // In v2, there's an additional "settle" step that actually
    // executes the token transfer.
    // -----------------------------------------------------------------------
    let verification: VerifyResponse;
    try {
      verification = await verifyPayment(
        env.FACILITATOR_URL,
        paymentPayload,
        paymentRequirements
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "Payment verification service unavailable" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!verification.isValid) {
      return new Response(
        JSON.stringify({
          error: "Payment verification failed",
          reason: verification.invalidReason ?? "Unknown reason",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Payment verified! Now call the upstream API (Tavily)
    //
    // From here on, it's just a normal API proxy — parse the request,
    // call Tavily, return the results. The x402 part is done.
    // -----------------------------------------------------------------------
    let body: { query: string; maxResults?: number; searchDepth?: "basic" | "advanced" };
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.query || typeof body.query !== "string") {
      return new Response(
        JSON.stringify({ error: "query is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const results = await tavilySearch(env.TAVILY_API_KEY, {
      query: body.query,
      maxResults: body.maxResults ?? 5,
      searchDepth: body.searchDepth ?? "basic",
    });

    return new Response(JSON.stringify(results), {
      headers: {
        "Content-Type": "application/json",
        // X-Payer tells the agent which wallet address paid.
        // Useful for logging, analytics, and multi-tenant scenarios.
        "X-Payer": verification.payer ?? "unknown",
      },
    });
  },
};
