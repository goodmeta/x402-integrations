/**
 * E2B Sandbox — x402 integration example
 *
 * Wraps the E2B sandbox creation API with x402 payment gating.
 * An agent pays in USDC per sandbox creation — no E2B account needed.
 *
 * Runs on Cloudflare Workers.
 */

import { createSandbox } from "./e2b";

interface Env {
  E2B_API_KEY: string;
  FACILITATOR_URL: string;
  PAY_TO: string;
  // "5000" = 0.005 USDC per sandbox creation (adjust based on E2B pricing)
  AMOUNT_REQUIRED: string;
}

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_NETWORK = "eip155:8453";

function buildPaymentRequirements(url: string, env: Env) {
  return {
    scheme: "exact",
    network: BASE_NETWORK,
    maxAmountRequired: env.AMOUNT_REQUIRED,
    resource: url,
    description: "E2B sandbox creation — isolated code execution environment",
    mimeType: "application/json",
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    extra: { name: "USD Coin", version: "2" },
  };
}

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
  if (!response.ok) throw new Error(`Facilitator ${response.status}`);
  return response.json() as Promise<VerifyResponse>;
}

function paymentRequiredResponse(paymentRequirements: unknown): Response {
  return new Response(
    JSON.stringify({ x402Version: 1, error: "Payment Required", accepts: [paymentRequirements] }),
    { status: 402, headers: { "Content-Type": "application/json", "X-Payment-Version": "1" } }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });

    if (url.pathname !== "/sandbox" || request.method !== "POST")
      return new Response(JSON.stringify({ error: "POST /sandbox required" }), { status: 405, headers: { "Content-Type": "application/json" } });

    const paymentRequirements = buildPaymentRequirements(request.url, env);
    const paymentHeader = request.headers.get("X-PAYMENT");

    if (!paymentHeader) return paymentRequiredResponse(paymentRequirements);

    let paymentPayload: unknown;
    try { paymentPayload = JSON.parse(atob(paymentHeader)); }
    catch { return new Response(JSON.stringify({ error: "Invalid X-PAYMENT header" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

    let verification: VerifyResponse;
    try { verification = await verifyPayment(env.FACILITATOR_URL, paymentPayload, paymentRequirements); }
    catch { return new Response(JSON.stringify({ error: "Payment verification unavailable" }), { status: 502, headers: { "Content-Type": "application/json" } }); }

    if (!verification.isValid)
      return new Response(JSON.stringify({ error: "Payment invalid", reason: verification.invalidReason }), { status: 401, headers: { "Content-Type": "application/json" } });

    let body: { template?: string; timeoutMs?: number };
    try { body = await request.json(); }
    catch { body = {}; }

    const sandbox = await createSandbox(env.E2B_API_KEY, {
      template: body.template ?? "base",
      timeoutMs: body.timeoutMs ?? 30000,
    });

    return new Response(JSON.stringify(sandbox), {
      headers: { "Content-Type": "application/json", "X-Payer": verification.payer ?? "unknown" },
    });
  },
};
