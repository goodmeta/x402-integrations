/**
 * Tavily Search — x402 integration example
 *
 * Wraps the Tavily Search API with x402 payment gating.
 * Runs on Cloudflare Workers.
 *
 * An agent hitting /search without payment gets a 402.
 * An agent with a valid X-PAYMENT header pays in USDC and
 * gets real Tavily search results back.
 */

import { tavilySearch } from "./tavily";

// ---------------------------------------------------------------------------
// Config — set via Cloudflare Worker environment variables
// ---------------------------------------------------------------------------

interface Env {
  TAVILY_API_KEY: string;
  FACILITATOR_URL: string;
  PAY_TO: string;
  // Amount in USDC base units (6 decimals): "1000" = 0.001 USDC per search
  AMOUNT_REQUIRED: string;
}

// Base mainnet USDC contract
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_NETWORK = "eip155:8453";

// ---------------------------------------------------------------------------
// Payment requirement builder
// ---------------------------------------------------------------------------

function buildPaymentRequirements(url: string, env: Env) {
  return {
    scheme: "exact",
    network: BASE_NETWORK,
    maxAmountRequired: env.AMOUNT_REQUIRED,
    resource: url,
    description: "Tavily web search — results for one query",
    mimeType: "application/json",
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    extra: {
      name: "USD Coin",
      version: "2",
    },
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

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only handle /search
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

    // Step 1: Check for X-PAYMENT header
    const paymentHeader = request.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return paymentRequiredResponse(paymentRequirements);
    }

    // Step 2: Decode the payment payload
    let paymentPayload: unknown;
    try {
      paymentPayload = JSON.parse(atob(paymentHeader));
    } catch {
      return new Response(
        JSON.stringify({ error: "X-PAYMENT header is not valid base64-encoded JSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 3: Verify with facilitator
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

    // Step 4: Parse request body and call Tavily
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
        // Let the agent know who paid (useful for logging/analytics)
        "X-Payer": verification.payer ?? "unknown",
      },
    });
  },
};
