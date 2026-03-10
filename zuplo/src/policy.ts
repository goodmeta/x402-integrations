/**
 * zuplo-x402-policy — x402 v2
 *
 * A drop-in Zuplo inbound policy that gates API requests behind x402
 * micropayments. Add this policy to any route in your zuplo.json and
 * agents will need to pay before accessing the endpoint.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  x402 v2 FLOW (this policy implements the server/merchant side)   │
 * │                                                                    │
 * │  1. Agent hits your API without payment                           │
 * │  2. This policy returns HTTP 402 with payment requirements        │
 * │  3. Agent signs a payment authorization (ERC-2612 Permit)         │
 * │  4. Agent retries with signed payment in PAYMENT-SIGNATURE header │
 * │  5. Policy sends payment to facilitator for VERIFICATION          │
 * │     → "Is this signature valid and does it cover the amount?"     │
 * │  6. Policy sends payment to facilitator for SETTLEMENT            │
 * │     → "Execute the on-chain token transfer now"                   │
 * │  7. If both pass, request proceeds to your backend                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * KEY DIFFERENCES FROM v1:
 *
 * ┌─────────────────────┬──────────────────────┬──────────────────────┐
 * │                     │  v1                  │  v2 (this policy)    │
 * ├─────────────────────┼──────────────────────┼──────────────────────┤
 * │ Payment header      │  X-PAYMENT           │  PAYMENT-SIGNATURE   │
 * │ Response header     │  X-Payment-Version   │  PAYMENT-REQUIRED    │
 * │ Version field       │  x402Version: 1      │  x402Version: 2      │
 * │ Settlement          │  None (verify only)  │  Verify + Settle     │
 * │ Tokens move?        │  No                  │  Yes (on-chain tx)   │
 * │ Payload format      │  Flat                │  { accepted, payload }│
 * └─────────────────────┴──────────────────────┴──────────────────────┘
 *
 * This policy accepts BOTH v1 (X-PAYMENT) and v2 (PAYMENT-SIGNATURE)
 * headers for backwards compatibility with older agent clients.
 *
 * Compatible with x402 v2 facilitators (SBC, Coinbase).
 * Runs on Cloudflare Workers — no Node.js built-ins used.
 */

import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-route configuration, set in zuplo.json under `options`.
 * These tell the policy how much to charge, where to send payments, etc.
 */
export interface X402PolicyOptions {
  /**
   * Base URL of the x402 facilitator service.
   * The facilitator is a trusted intermediary that:
   *   1. Verifies payment signatures (cryptographic check)
   *   2. Settles payments on-chain (executes the token transfer)
   *
   * Think of it like Stripe — you don't process credit cards yourself,
   * you send them to Stripe. Similarly, you don't verify blockchain
   * signatures yourself, you send them to the facilitator.
   *
   * Examples:
   *   - SBC:      "https://x402.stablecoin.xyz"
   *   - Coinbase: "https://x402.coinbase.com"
   */
  facilitatorUrl: string;

  /** Merchant wallet address that receives payments (your 0x... address) */
  payTo: string;

  /**
   * CAIP-2 network identifier — which blockchain to accept payments on.
   * Format: "eip155:{chainId}"
   *
   * Common values:
   *   "eip155:8453"  — Base mainnet (recommended, low fees)
   *   "eip155:1"     — Ethereum mainnet (high fees)
   *   "eip155:84532" — Base Sepolia testnet
   */
  network: string;

  /**
   * ERC-20 token contract address used for payment.
   * This is the smart contract that holds the token (e.g., USDC).
   *
   * Common values:
   *   Base USDC:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
   *   Base Sepolia: varies per token
   */
  asset: string;

  /**
   * Amount required in token base units (smallest denomination).
   * Tokens have decimal places — USDC has 6, so:
   *   "1000"    = 0.001 USDC ($0.001)
   *   "10000"   = 0.01  USDC ($0.01)
   *   "1000000" = 1.00  USDC ($1.00)
   */
  maxAmountRequired: string;

  /** Human-readable description shown to the paying agent in the 402 response */
  description?: string;

  /** Maximum seconds the payment authorization remains valid. Default: 300 (5 min) */
  maxTimeoutSeconds?: number;

  /**
   * Token name for the EIP-712 domain separator.
   * Must match the `name()` in the token's smart contract.
   * Default: "Stable Coin"
   *
   * EIP-712 is the standard that enables "gasless" signatures —
   * the agent signs structured data without paying blockchain gas fees.
   * The domain separator (name + version + chainId + contract address)
   * ensures signatures can't be replayed on different tokens or chains.
   */
  tokenName?: string;

  /** Token version for EIP-712 domain. Must match the contract. Default: "1" */
  tokenVersion?: string;

  /** Facilitator contract address for EIP-712 domain (optional) */
  facilitatorAddress?: string;

  /**
   * Whether to settle (execute) the payment on-chain after verification.
   * Default: true
   *
   * When true (v2 behavior):
   *   Verify checks the signature → Settle executes the token transfer.
   *   The agent's tokens actually move to your wallet on-chain.
   *
   * When false (v1-like behavior):
   *   Only verification — no tokens move. Useful for testing or
   *   when you handle settlement separately.
   */
  settle?: boolean;
}

/**
 * The decoded payload from the PAYMENT-SIGNATURE / X-PAYMENT header.
 *
 * v2 format includes:
 *   { x402Version: 2, accepted: { scheme, network }, payload: { signature, authorization } }
 *
 * The `payload.signature` is the ERC-2612 Permit signature — a cryptographic
 * proof that the agent authorized a token transfer without paying gas.
 */
type PaymentPayload = Record<string, unknown>;

/**
 * Payment requirements — sent to the agent in 402 responses and to
 * the facilitator during verify/settle.
 */
interface PaymentRequirements {
  /** Payment scheme — "exact" means pay the exact listed amount */
  scheme: string;

  /** CAIP-2 network identifier (e.g., "eip155:8453" for Base) */
  network: string;

  /** Amount in token base units (e.g., "1000000" = 1 USDC) */
  maxAmountRequired: string;

  /**
   * SBC facilitator reads `amount` instead of `maxAmountRequired`.
   * We include both for cross-facilitator compatibility.
   */
  amount: string;

  /** The API endpoint URL being accessed */
  resource: string;

  /** Human-readable description */
  description?: string;

  /** Response MIME type */
  mimeType: string;

  /** Merchant wallet address */
  payTo: string;

  /** How long the payment authorization stays valid (seconds) */
  maxTimeoutSeconds: number;

  /** Token contract address */
  asset: string;

  /** Facilitator contract address (optional) */
  facilitator?: string;

  /**
   * EIP-712 domain info for the token.
   * name + version must match what's hardcoded in the token's smart contract.
   */
  extra: {
    name: string;
    version: string;
  };
}

/**
 * Response from the facilitator's /verify endpoint.
 * The facilitator checks the signature and returns whether it's valid.
 */
interface VerifyResponse {
  /** Whether the payment authorization is cryptographically valid */
  isValid: boolean;
  /** The wallet address that signed the payment (extracted from signature) */
  payer: string | null;
  /** Why verification failed, if it did */
  invalidReason: string | null;
}

/**
 * Response from the facilitator's /settle endpoint.
 * Settlement executes the actual on-chain token transfer.
 * The facilitator submits a blockchain transaction to move tokens
 * from the payer's wallet to the merchant's wallet.
 */
interface SettleResponse {
  /** Whether the on-chain transaction was submitted successfully */
  success: boolean;
  /** Blockchain transaction hash (can be looked up on a block explorer) */
  txHash?: string;
  /** Alternative field name for transaction hash (some facilitators use this) */
  transaction?: string;
  /** Error message if settlement failed */
  error?: string;
  /** Detailed error reason */
  errorReason?: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Main policy function — Zuplo calls this for every incoming request
 * on routes where this policy is configured.
 *
 * Returns either:
 *   - ZuploRequest (pass-through to backend — payment verified)
 *   - Response (402 payment required, 401 invalid, 502 facilitator down)
 */
export default async function policy(
  request: ZuploRequest,
  context: ZuploContext,
  options: X402PolicyOptions,
  policyName: string
): Promise<ZuploRequest | Response> {

  const settle = options.settle ?? true;
  const paymentRequirements = buildPaymentRequirements(request, options);

  // ------------------------------------------------------------------
  // Step 1: Check for payment header
  //
  // v2 agents send PAYMENT-SIGNATURE, v1 agents send X-PAYMENT.
  // We check both for backwards compatibility.
  // If neither is present, the agent hasn't attempted payment yet.
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
  //
  // The agent encodes its payment as: base64(JSON.stringify(paymentData))
  // This contains the cryptographic signature and authorization details.
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
  //
  // Send the payment payload + our requirements to the facilitator.
  // It checks:
  //   - Signature is cryptographically valid (not forged)
  //   - Amount covers what we require
  //   - Payment is addressed to our wallet
  //   - Authorization hasn't expired
  //   - Payer has sufficient token balance
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
  // Step 4: Settle on-chain (v2 only, default: true)
  //
  // THIS IS THE KEY v2 ADDITION.
  //
  // In v1, verification was the last step — no tokens actually moved.
  // In v2, settlement triggers an on-chain transaction:
  //   1. Facilitator calls the token contract's `transferFrom`
  //   2. Using the agent's ERC-2612 Permit signature as authorization
  //   3. Tokens transfer from payer → merchant wallet
  //   4. Returns a transaction hash you can verify on a block explorer
  //
  // Set `settle: false` in options to skip this (verify-only mode).
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

  // Payment verified (and settled if enabled) — let the request through
  return request;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constructs the paymentRequirements object for this route.
 * This tells agents exactly what payment to construct.
 */
function buildPaymentRequirements(
  request: ZuploRequest,
  options: X402PolicyOptions
): PaymentRequirements {
  return {
    scheme: "exact",
    network: options.network,
    maxAmountRequired: options.maxAmountRequired,
    // Duplicate `amount` for SBC facilitator compat (it reads `amount`, not `maxAmountRequired`)
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
 * v2 differences from v1:
 * - Body includes x402Version: 2
 * - PAYMENT-REQUIRED header contains base64-encoded requirements
 *   (this lets agents parse requirements from the header alone,
 *    without reading the response body)
 * - v1 used X-Payment-Version header instead
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

  // Base64-encode the full response for the PAYMENT-REQUIRED header
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
 * Payment headers are encoded as: base64(JSON.stringify(data))
 */
function decodeBase64Json(value: string): PaymentPayload {
  const jsonString = atob(value);
  return JSON.parse(jsonString) as PaymentPayload;
}

/**
 * Calls the facilitator's /verify endpoint.
 *
 * Sends the agent's payment payload alongside our requirements.
 * The facilitator checks the cryptographic signature and confirms
 * the payment authorization is valid.
 *
 * This step does NOT move any tokens — it's just a signature check.
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
 *
 * THIS IS THE v2 STEP THAT ACTUALLY MOVES TOKENS.
 *
 * The facilitator:
 *   1. Takes the agent's ERC-2612 Permit signature
 *   2. Submits a blockchain transaction calling `permit()` then `transferFrom()`
 *   3. Tokens move from the agent's wallet to your merchant wallet
 *   4. Returns the transaction hash (viewable on block explorers like basescan.org)
 *
 * The agent pays no gas fees — the facilitator covers gas and is
 * compensated through the protocol.
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
