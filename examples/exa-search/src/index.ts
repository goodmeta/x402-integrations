/**
 * Exa Search — x402 v1 integration example
 *
 * Wraps the Exa semantic search API with x402 payment gating.
 * Same pattern as the Tavily example — swap the upstream API,
 * keep the same x402 middleware. This shows how any API can
 * be made pay-per-use with minimal code.
 *
 * This is an x402 v1 example:
 * - Uses the X-PAYMENT header (v1)
 * - Verify-only — no on-chain settlement
 * - Returns x402Version: 1 in 402 responses
 *
 * For the v2 flow (with on-chain settlement), see the Zuplo policy.
 *
 * Runs on Cloudflare Workers.
 */

import { exaSearch } from "./exa";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Env {
  /** Your Exa API key — the upstream service we're wrapping with payments */
  EXA_API_KEY: string;

  /** x402 facilitator URL — see Tavily example for detailed explanation */
  FACILITATOR_URL: string;

  /** Your wallet address that receives payments */
  PAY_TO: string;

  /** Price per search in USDC base units (6 decimals) */
  AMOUNT_REQUIRED: string;
}

/** USDC contract address on Base mainnet */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** CAIP-2 network identifier for Base mainnet */
const BASE_NETWORK = "eip155:8453";

// ---------------------------------------------------------------------------
// Payment requirement builder
// ---------------------------------------------------------------------------

/**
 * Tells the agent: "Pay this much USDC to this address for one search."
 * Returned in the 402 response body.
 */
function buildPaymentRequirements(url: string, env: Env) {
  return {
    scheme: "exact",
    network: BASE_NETWORK,
    maxAmountRequired: env.AMOUNT_REQUIRED,
    resource: url,
    description: "Exa semantic search — results for one query",
    mimeType: "application/json",
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    /** EIP-712 domain info — must match the USDC contract's domain separator */
    extra: { name: "USD Coin", version: "2" },
  };
}

// ---------------------------------------------------------------------------
// Facilitator verification
// ---------------------------------------------------------------------------

interface VerifyResponse {
  isValid: boolean;
  payer: string | null;
  invalidReason: string | null;
}

/**
 * Verifies the agent's payment signature with the facilitator.
 * v1 = verify-only, no on-chain settlement.
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
  if (!response.ok) throw new Error(`Facilitator ${response.status}`);
  return response.json() as Promise<VerifyResponse>;
}

// ---------------------------------------------------------------------------
// 402 response (v1 format)
// ---------------------------------------------------------------------------

/**
 * Returns HTTP 402 with payment instructions (x402 v1 format).
 * See Tavily example for v1 vs v2 differences.
 */
function paymentRequiredResponse(paymentRequirements: unknown): Response {
  return new Response(
    JSON.stringify({ x402Version: 1, error: "Payment Required", accepts: [paymentRequirements] }),
    { status: 402, headers: { "Content-Type": "application/json", "X-Payment-Version": "1" } }
  );
}

// ---------------------------------------------------------------------------
// Worker handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });

    if (url.pathname !== "/search" || request.method !== "POST")
      return new Response(JSON.stringify({ error: "POST /search required" }), { status: 405, headers: { "Content-Type": "application/json" } });

    const paymentRequirements = buildPaymentRequirements(request.url, env);

    // Step 1: Check for X-PAYMENT header (v1).
    // No header = agent hasn't paid yet → return 402 with instructions.
    const paymentHeader = request.headers.get("X-PAYMENT");
    if (!paymentHeader) return paymentRequiredResponse(paymentRequirements);

    // Step 2: Decode base64-encoded payment payload from the header
    let paymentPayload: unknown;
    try { paymentPayload = JSON.parse(atob(paymentHeader)); }
    catch { return new Response(JSON.stringify({ error: "Invalid X-PAYMENT header" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

    // Step 3: Verify with facilitator (v1 = verify-only, no settlement)
    let verification: VerifyResponse;
    try { verification = await verifyPayment(env.FACILITATOR_URL, paymentPayload, paymentRequirements); }
    catch { return new Response(JSON.stringify({ error: "Payment verification unavailable" }), { status: 502, headers: { "Content-Type": "application/json" } }); }

    if (!verification.isValid)
      return new Response(JSON.stringify({ error: "Payment invalid", reason: verification.invalidReason }), { status: 401, headers: { "Content-Type": "application/json" } });

    // Step 4: Payment verified — call the upstream Exa API
    let body: { query: string; numResults?: number; useAutoprompt?: boolean };
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

    if (!body.query)
      return new Response(JSON.stringify({ error: "query is required" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const results = await exaSearch(env.EXA_API_KEY, {
      query: body.query,
      numResults: body.numResults ?? 5,
      useAutoprompt: body.useAutoprompt ?? true,
    });

    return new Response(JSON.stringify(results), {
      headers: { "Content-Type": "application/json", "X-Payer": verification.payer ?? "unknown" },
    });
  },
};
