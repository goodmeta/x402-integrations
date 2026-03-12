/**
 * x402 Integration Test — Apify Actor Payment Flow
 *
 * This script simulates the complete payment flow for an Apify Actor run
 * using USDC on Base. It follows the exact pattern described in the
 * technical package (Section 4: Integration Pattern).
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THIS SIMULATES                                              │
 * │                                                                    │
 * │  1. Agent calls Apify API → gets 402 with payment requirements    │
 * │  2. Agent signs an ERC-2612 Permit for USDC (off-chain, free)     │
 * │  3. Agent sends signed payment to the API                         │
 * │  4. Apify middleware calls /verify → is the payment valid?        │
 * │  5. Actor runs                                                     │
 * │  6. Apify middleware calls /settle → move USDC on-chain           │
 * │  7. Agent receives Actor results                                   │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * This test runs both sides: it acts as the agent (signing the permit)
 * AND as Apify's middleware (calling verify + settle). In production,
 * these are separate — the agent signs, your middleware verifies/settles.
 *
 * Prerequisites:
 *   - A wallet with USDC on Base Sepolia (testnet — free tokens)
 *   - USDC Sepolia contract: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 *   - Get testnet USDC from the Base Sepolia faucet
 *
 * Usage:
 *   # Test against the live facilitator (Base Sepolia testnet)
 *   PRIVATE_KEY=0xYourWalletKey pnpm test:apify
 *
 *   # Test against a local facilitator
 *   PRIVATE_KEY=0xYourWalletKey FACILITATOR_URL=http://localhost:3001 pnpm test:apify
 *
 * Token domains (verified on-chain — these MUST match for signatures to work):
 *   Base Mainnet USDC (0x833589...): name="USD Coin", version="2"
 *   Base Sepolia USDC (0x036CbD...): name="USDC",     version="2"
 */

import { createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The facilitator service URL. Default: live SBC facilitator. */
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.stablecoin.xyz";

/** CAIP-2 network identifier for Base Sepolia (testnet). */
const NETWORK = "eip155:84532";

/**
 * USDC token on Base Sepolia.
 *
 * IMPORTANT: The EIP-712 domain name for this contract is "USDC" (not "USD Coin").
 * On Base Mainnet, the domain name is "USD Coin". This difference matters —
 * using the wrong name will produce a valid-looking signature that fails on-chain.
 * Always verify the domain by calling name() on the token contract.
 */
const USDC_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_DECIMALS = 6;
const USDC_DOMAIN_NAME = "USDC"; // Sepolia. Use "USD Coin" for mainnet.
const USDC_DOMAIN_VERSION = "2";

/**
 * Amount to pay in USDC base units (6 decimals).
 * 5000 = 0.005 USDC = $0.005 — simulates a cheap Actor run.
 */
const AMOUNT = "5000";

// ---------------------------------------------------------------------------
// ABIs — minimal interfaces for the functions we call
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "nonces",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  x402 Apify Actor Payment — Integration Test           ║");
  console.log("║  Token: USDC on Base Sepolia (testnet)                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // --- Setup ---

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("Set PRIVATE_KEY env var to your test wallet private key.");
    console.error("  PRIVATE_KEY=0x... pnpm test:apify");
    process.exit(1);
  }

  const agentWallet = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Agent wallet:  ${agentWallet.address}`);
  console.log(`Facilitator:   ${FACILITATOR_URL}`);
  console.log(`Token:         USDC (${USDC_TOKEN})`);
  console.log(`Amount:        ${formatUnits(BigInt(AMOUNT), USDC_DECIMALS)} USDC\n`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  // --- Get facilitator signer address ---
  // The facilitator's signer is the address authorized to spend tokens via permit.
  // In production, your 402 response includes the facilitatorUrl — the agent
  // fetches /supported to discover the signer address automatically.

  const supported = await fetch(`${FACILITATOR_URL}/supported`).then((r) =>
    r.json()
  );
  const facilitatorSigner = supported.signers?.["eip155:*"]?.[0];
  if (!facilitatorSigner) {
    console.error("No EVM signer found at facilitator /supported endpoint.");
    process.exit(1);
  }
  console.log(`Facilitator signer: ${facilitatorSigner}\n`);

  // =========================================================================
  // STEP 1: Agent checks USDC balance
  //
  // Before signing a permit, check that the wallet actually has enough USDC.
  // In production, the agent's x402 client library does this automatically.
  // =========================================================================

  console.log("Step 1: Check USDC balance");
  const balance = await publicClient.readContract({
    address: USDC_TOKEN as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [agentWallet.address],
  });
  console.log(`  Balance: ${formatUnits(balance, USDC_DECIMALS)} USDC`);

  if (balance < BigInt(AMOUNT)) {
    console.error(`\n  Insufficient USDC. Need ${formatUnits(BigInt(AMOUNT), USDC_DECIMALS)} USDC.`);
    console.error(`  Get testnet USDC from the Base Sepolia faucet.`);
    process.exit(1);
  }
  console.log("  ✓ Sufficient balance\n");

  // =========================================================================
  // STEP 2: Agent gets permit nonce
  //
  // Each permit includes a nonce (counter) to prevent replay attacks.
  // The nonce auto-increments on-chain each time a permit is consumed.
  // =========================================================================

  console.log("Step 2: Get permit nonce");
  const nonce = await publicClient.readContract({
    address: USDC_TOKEN as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "nonces",
    args: [agentWallet.address],
  });
  console.log(`  Nonce: ${nonce}\n`);

  // =========================================================================
  // STEP 3: Agent signs ERC-2612 Permit
  //
  // The agent signs a typed message (EIP-712) authorizing the facilitator
  // to spend a specific amount of USDC. This is:
  //   - FREE — no gas, no on-chain transaction
  //   - INSTANT — just a cryptographic signature
  //   - SCOPED — only the facilitator can use it, and only before the deadline
  //
  // The domain fields MUST match the token contract's on-chain values:
  //   name: "USDC" (Sepolia) or "USD Coin" (mainnet)
  //   version: "2"
  //   chainId: 84532 (Sepolia) or 8453 (mainnet)
  //   verifyingContract: the USDC contract address
  //
  // If any domain field is wrong, the signature will verify off-chain
  // (our test will pass) but fail on-chain (settlement will revert).
  // We caught this exact bug: Sepolia uses "USDC", mainnet uses "USD Coin".
  // =========================================================================

  console.log("Step 3: Sign ERC-2612 Permit (off-chain, free)");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min
  console.log(`  Owner (agent):     ${agentWallet.address}`);
  console.log(`  Spender (facilitator): ${facilitatorSigner}`);
  console.log(`  Amount: ${formatUnits(BigInt(AMOUNT), USDC_DECIMALS)} USDC`);
  console.log(`  Deadline: ${new Date(Number(deadline) * 1000).toISOString()}`);

  const signature = await signTypedData({
    privateKey: privateKey as `0x${string}`,
    domain: {
      name: USDC_DOMAIN_NAME,
      version: USDC_DOMAIN_VERSION,
      chainId: baseSepolia.id,
      verifyingContract: USDC_TOKEN as `0x${string}`,
    },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: {
      owner: agentWallet.address,
      spender: facilitatorSigner as `0x${string}`,
      value: BigInt(AMOUNT),
      nonce,
      deadline,
    },
  });
  console.log(`  Signature: ${signature.slice(0, 20)}...`);
  console.log("  ✓ Permit signed\n");

  // =========================================================================
  // STEP 4: Build x402 payment payload
  //
  // Package the signature + authorization into the x402 v2 format.
  // In production, the agent's x402 client library builds this and sends it
  // as a base64-encoded PAYMENT-SIGNATURE header on the API request.
  //
  // The paymentRequirements come from the 402 response — they define what
  // the merchant (Apify) expects: which token, how much, where to send it.
  // =========================================================================

  console.log("Step 4: Build x402 v2 payment payload");

  const paymentPayload = {
    x402Version: 2,
    accepted: { scheme: "exact", network: NETWORK },
    payload: {
      signature,
      authorization: {
        from: agentWallet.address,
        to: facilitatorSigner,
        value: AMOUNT,
        validAfter: "0",
        validBefore: deadline.toString(),
        nonce: nonce.toString(),
      },
    },
  };

  // These payment requirements simulate what Apify's 402 response would contain.
  // In production, these are generated by your middleware based on the Actor pricing.
  const paymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT,
    asset: USDC_TOKEN,
    payTo: agentWallet.address, // In production: Apify's receiving wallet
    maxTimeoutSeconds: 300,
    extra: {
      name: USDC_DOMAIN_NAME,
      version: USDC_DOMAIN_VERSION,
    },
  };

  console.log("  ✓ Payload built\n");

  // =========================================================================
  // STEP 5: Apify middleware calls /verify
  //
  // THIS IS WHAT YOUR MIDDLEWARE DOES (server side).
  //
  // Before running the Actor, verify the payment is legitimate:
  //   - Signature is cryptographically valid
  //   - Amount covers the Actor cost
  //   - Permit hasn't expired
  //   - Agent's wallet has enough USDC
  //
  // No tokens move yet. This is a read-only check.
  //
  // The response includes `remainingSeconds` — how long until the permit
  // expires. Use this to decide if the permit will last long enough for
  // the Actor run. See tech package Section 7 for long-running Actor handling.
  // =========================================================================

  console.log("Step 5: POST /verify (Apify middleware checks payment)");
  const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });
  const verifyResult = await verifyRes.json();

  if (!verifyResult.isValid) {
    console.error(`  ✗ Verification failed: ${verifyResult.invalidReason}`);
    process.exit(1);
  }

  console.log(`  ✓ Payment valid`);
  console.log(`  Payer: ${verifyResult.payer}`);
  console.log(`  Remaining seconds: ${verifyResult.remainingSeconds}`);
  console.log();

  // =========================================================================
  // STEP 5b: Actor runs here
  //
  // In production, this is where you'd execute the Actor:
  //
  //   const actorResult = await runActor(actorId, inputData);
  //   const actualCost = calculateCost(actorResult);
  //
  // For this test, we simulate it.
  // =========================================================================

  console.log("Step 5b: [Simulated] Actor runs...");
  console.log("  Actor: web-scraper");
  console.log("  Result: 42 pages scraped");
  console.log("  Cost: 0.005 USDC\n");

  // =========================================================================
  // STEP 6: Apify middleware calls /settle
  //
  // THIS IS WHERE TOKENS MOVE ON-CHAIN.
  //
  // After the Actor completes, settle the payment. The facilitator:
  //   1. Calls permit() on the USDC contract (authorizes spending)
  //   2. Calls transferFrom() (moves USDC from agent → Apify wallet)
  //
  // The facilitator pays the gas. Apify receives USDC directly.
  //
  // The response includes a transaction hash — verifiable on BaseScan.
  //
  // IMPORTANT: Keep the window between verify and settle short.
  // If the permit expires before settlement, you'll get `permit_expired`.
  // The `remainingSeconds` from verify tells you how much time you have.
  // =========================================================================

  console.log("Step 6: POST /settle (execute on-chain USDC transfer)");
  const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });
  const settleResult = await settleRes.json();

  if (!settleResult.success) {
    console.error(`  ✗ Settlement failed: ${settleResult.errorReason}`);
    console.log("\n  Verify passed but settle failed.");
    console.log("  Common causes:");
    console.log("    - permit_expired: took too long between verify and settle");
    console.log("    - insufficient_gas: facilitator wallet needs ETH for gas");
    console.log("    - nonce_already_settled: this permit was already used");
    process.exit(1);
  }

  const txHash = settleResult.transaction;
  console.log(`  ✓ Settlement successful`);
  console.log(`  TX: ${txHash}`);
  console.log(`  Explorer: https://sepolia.basescan.org/tx/${txHash}`);

  // =========================================================================
  // Summary
  // =========================================================================

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  TEST PASSED — Full Apify Actor payment flow           ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Network:     Base Sepolia (testnet)                    ║`);
  console.log(`║  Token:       USDC                                     ║`);
  console.log(`║  Amount:      ${formatUnits(BigInt(AMOUNT), USDC_DECIMALS).padEnd(42)}║`);
  console.log(`║  Agent:       ${agentWallet.address.slice(0, 10)}...${agentWallet.address.slice(-8)}                       ║`);
  console.log(`║  Facilitator: ${FACILITATOR_URL.padEnd(42)}║`);
  console.log(`║  TX:          ${(txHash as string).slice(0, 10)}...${(txHash as string).slice(-8)}                       ║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
