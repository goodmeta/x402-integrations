/**
 * zuplo-x402-policy
 *
 * An inbound Zuplo policy that gates API requests behind x402 micropayments.
 * Compliant with the x402 payment protocol specification.
 *
 * Runs on Cloudflare Workers — no Node.js built-ins used.
 */

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-route configuration, set in zuplo.json under `options`.
 */
export interface X402PolicyOptions {
  /** Base URL of the x402 facilitator, e.g. "https://facilitator.stablecoin.xyz" */
  facilitatorUrl: string;

  /** Merchant wallet address that receives payments */
  payTo: string;

  /** CAIP-2 network identifier, e.g. "eip155:8453" (Base mainnet) */
  network: string;

  /** ERC-20 token contract address used for payment */
  asset: string;

  /** Amount required in token base units, e.g. "1000000" = 1 USDC (6 decimals) */
  maxAmountRequired: string;

  /** Human-readable description shown to the paying agent in the 402 response */
  description?: string;

  /** Maximum seconds the payment authorization remains valid. Default: 300 */
  maxTimeoutSeconds?: number;

  /** Token name for EIP-712 domain. Default: "Stable Coin" */
  tokenName?: string;

  /** Token version for EIP-712 domain. Default: "1" */
  tokenVersion?: string;
}

/**
 * The decoded payload extracted from the X-PAYMENT header.
 * Structure defined by the x402 spec — passed as-is to the facilitator.
 */
type PaymentPayload = Record<string, unknown>;

/**
 * Response from the facilitator's /verify endpoint.
 */
interface VerifyResponse {
  isValid: boolean;
  payer: string | null;
  invalidReason: string | null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export default async function policy(
  request: ZuploRequest,
  context: ZuploContext,
  options: X402PolicyOptions,
  policyName: string
): Promise<ZuploRequest | Response> {

  // Build the payment requirements object once — used in both the 402 response
  // and the facilitator verify call.
  const paymentRequirements = buildPaymentRequirements(request, options);

  // ------------------------------------------------------------------
  // Step 1: Check for the X-PAYMENT header
  // ------------------------------------------------------------------
  const paymentHeader = request.headers.get("X-PAYMENT");

  if (!paymentHeader) {
    context.log.info(`[${policyName}] No X-PAYMENT header — returning 402`);
    return paymentRequiredResponse(paymentRequirements);
  }

  // ------------------------------------------------------------------
  // Step 2: Decode the payment payload from base64 JSON
  // ------------------------------------------------------------------
  let paymentPayload: PaymentPayload;

  try {
    paymentPayload = decodePaymentHeader(paymentHeader);
  } catch (err) {
    context.log.warn(`[${policyName}] Failed to decode X-PAYMENT header: ${err}`);
    return new Response(
      JSON.stringify({ error: "X-PAYMENT header is not valid base64-encoded JSON" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // ------------------------------------------------------------------
  // Step 3: Verify with the facilitator
  // ------------------------------------------------------------------
  let verification: VerifyResponse;

  try {
    verification = await verifyPayment(
      options.facilitatorUrl,
      paymentPayload,
      paymentRequirements
    );
  } catch (err) {
    context.log.error(`[${policyName}] Facilitator request failed: ${err}`);
    return new Response(
      JSON.stringify({ error: "Payment verification service unavailable" }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // ------------------------------------------------------------------
  // Step 4: Allow or reject based on verification result
  // ------------------------------------------------------------------
  if (!verification.isValid) {
    context.log.warn(
      `[${policyName}] Payment invalid — reason: ${verification.invalidReason}`
    );
    return new Response(
      JSON.stringify({
        error: "Payment verification failed",
        reason: verification.invalidReason ?? "Unknown reason",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  context.log.info(`[${policyName}] Payment verified — payer: ${verification.payer}`);

  // Note: Zuplo doesn't support mutating request headers directly; the payer
  // address is available in logs. For downstream access, use a custom header
  // set via a separate inbound policy or pass via context.custom.
  // See README for the recommended pattern.

  return request; // pass through to the backend
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constructs the paymentRequirements object for this route.
 * Used in both the 402 body and the facilitator verify call.
 */
function buildPaymentRequirements(
  request: ZuploRequest,
  options: X402PolicyOptions
) {
  return {
    scheme: "exact",
    network: options.network,
    maxAmountRequired: options.maxAmountRequired,
    resource: request.url,
    description: options.description ?? "Access to this API endpoint",
    mimeType: "application/json",
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
    asset: options.asset,
    extra: {
      name: options.tokenName ?? "Stable Coin",
      version: options.tokenVersion ?? "1",
    },
  };
}

/**
 * Returns an HTTP 402 response in the x402 spec format.
 */
function paymentRequiredResponse(
  paymentRequirements: ReturnType<typeof buildPaymentRequirements>
): Response {
  const body = {
    x402Version: 1,
    error: "Payment Required",
    accepts: [paymentRequirements],
  };

  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      // Hint to clients that x402 is in use
      "X-Payment-Version": "1",
    },
  });
}

/**
 * Decodes the X-PAYMENT header value from base64-encoded JSON.
 */
function decodePaymentHeader(headerValue: string): PaymentPayload {
  // atob is available in both browsers and Cloudflare Workers
  const jsonString = atob(headerValue);
  return JSON.parse(jsonString) as PaymentPayload;
}

/**
 * Calls the facilitator's /verify endpoint.
 * Throws on network errors or non-2xx responses.
 */
async function verifyPayment(
  facilitatorUrl: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: ReturnType<typeof buildPaymentRequirements>
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
