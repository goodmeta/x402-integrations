/**
 * zuplo-x402-policy (v2)
 *
 * An inbound Zuplo policy that gates API requests behind x402 micropayments.
 * Compatible with x402 v2 facilitators (SBC, Coinbase).
 *
 * v2 changes from v1:
 * - Reads PAYMENT-SIGNATURE header (v2) with X-PAYMENT fallback (v1)
 * - Returns x402Version: 2 in 402 response
 * - Sets PAYMENT-REQUIRED header (base64-encoded requirements)
 * - Payment payload uses `accepted` envelope with scheme + network
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
  /** Base URL of the x402 facilitator, e.g. "https://x402.stablecoin.xyz" */
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

  /** Facilitator contract address for EIP-712 domain (optional) */
  facilitatorAddress?: string;

  /** Whether to settle payment on-chain after verification. Default: true */
  settle?: boolean;
}

/**
 * The decoded payload from the PAYMENT-SIGNATURE / X-PAYMENT header.
 * x402 v2 format: { x402Version, accepted: { scheme, network }, payload, ... }
 */
type PaymentPayload = Record<string, unknown>;

/**
 * Payment requirements sent in the 402 response and to the facilitator.
 */
interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  /** SBC facilitator reads `amount` instead of `maxAmountRequired`. Include both for compatibility. */
  amount: string;
  resource: string;
  description?: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  facilitator?: string;
  extra: {
    name: string;
    version: string;
  };
}

/**
 * Response from the facilitator's /verify endpoint.
 */
interface VerifyResponse {
  isValid: boolean;
  payer: string | null;
  invalidReason: string | null;
}

/**
 * Response from the facilitator's /settle endpoint.
 */
interface SettleResponse {
  success: boolean;
  txHash?: string;
  transaction?: string;
  error?: string;
  errorReason?: string;
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

  const settle = options.settle ?? true;
  const paymentRequirements = buildPaymentRequirements(request, options);

  // ------------------------------------------------------------------
  // Step 1: Check for payment header (v2: PAYMENT-SIGNATURE, v1: X-PAYMENT)
  // ------------------------------------------------------------------
  const paymentHeader =
    request.headers.get("PAYMENT-SIGNATURE") ??
    request.headers.get("X-PAYMENT");

  if (!paymentHeader) {
    context.log.info(`[${policyName}] No payment header — returning 402`);
    return paymentRequiredResponse(paymentRequirements);
  }

  // ------------------------------------------------------------------
  // Step 2: Decode the payment payload from base64 JSON
  // ------------------------------------------------------------------
  let paymentPayload: PaymentPayload;

  try {
    paymentPayload = decodeBase64Json(paymentHeader);
  } catch (err) {
    context.log.warn(`[${policyName}] Failed to decode payment header: ${err}`);
    return paymentRequiredResponse(paymentRequirements, "Invalid payment header");
  }

  // ------------------------------------------------------------------
  // Step 3: Verify with the facilitator
  // ------------------------------------------------------------------
  let verification: VerifyResponse;

  try {
    verification = await facilitatorVerify(
      options.facilitatorUrl,
      paymentPayload,
      paymentRequirements
    );
  } catch (err) {
    context.log.error(`[${policyName}] Facilitator verify failed: ${err}`);
    return new Response(
      JSON.stringify({ error: "Payment verification service unavailable" }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

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

  // ------------------------------------------------------------------
  // Step 4: Settle on-chain (optional, default: true)
  // ------------------------------------------------------------------
  if (settle) {
    let settlement: SettleResponse;

    try {
      settlement = await facilitatorSettle(
        options.facilitatorUrl,
        paymentPayload,
        paymentRequirements
      );
    } catch (err) {
      context.log.error(`[${policyName}] Facilitator settle failed: ${err}`);
      return new Response(
        JSON.stringify({ error: "Payment settlement service unavailable" }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!settlement.success) {
      context.log.warn(`[${policyName}] Settlement failed: ${settlement.error ?? settlement.errorReason}`);
      return new Response(
        JSON.stringify({
          error: "Payment settlement failed",
          reason: settlement.error ?? settlement.errorReason ?? "Unknown reason",
        }),
        {
          status: 402,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const txHash = settlement.txHash ?? settlement.transaction;
    context.log.info(`[${policyName}] Payment settled — tx: ${txHash}`);
  }

  return request; // pass through to the backend
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constructs the paymentRequirements object for this route.
 */
function buildPaymentRequirements(
  request: ZuploRequest,
  options: X402PolicyOptions
): PaymentRequirements {
  return {
    scheme: "exact",
    network: options.network,
    maxAmountRequired: options.maxAmountRequired,
    amount: options.maxAmountRequired,
    resource: request.url,
    description: options.description ?? "Access to this API endpoint",
    mimeType: "application/json",
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
    asset: options.asset,
    facilitator: options.facilitatorAddress,
    extra: {
      name: options.tokenName ?? "Stable Coin",
      version: options.tokenVersion ?? "1",
    },
  };
}

/**
 * Returns an HTTP 402 response in the x402 v2 spec format.
 *
 * v2 additions:
 * - PAYMENT-REQUIRED header with base64-encoded requirements
 * - x402Version: 2
 */
function paymentRequiredResponse(
  paymentRequirements: PaymentRequirements,
  errorMessage?: string
): Response {
  const body = {
    x402Version: 2,
    accepts: [paymentRequirements],
    ...(errorMessage ? { error: errorMessage } : { error: "Payment Required" }),
  };

  const paymentRequiredHeader = btoa(JSON.stringify(body));

  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": paymentRequiredHeader,
    },
  });
}

/**
 * Decodes a base64-encoded JSON string.
 */
function decodeBase64Json(value: string): PaymentPayload {
  const jsonString = atob(value);
  return JSON.parse(jsonString) as PaymentPayload;
}

/**
 * Calls the facilitator's /verify endpoint.
 * Sends { paymentPayload, paymentRequirements } as raw JSON.
 */
async function facilitatorVerify(
  facilitatorUrl: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements
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

/**
 * Calls the facilitator's /settle endpoint.
 * Triggers on-chain transfer of funds after verification.
 */
async function facilitatorSettle(
  facilitatorUrl: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements
): Promise<SettleResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, "")}/settle`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Facilitator returned ${response.status}: ${text}`);
  }

  return response.json() as Promise<SettleResponse>;
}
