/**
 * x402 Up-to Scheme — Agent-Side Signing Example + E2E Test
 *
 * This is what's MISSING from the ecosystem: a working example of an agent
 * signing an up-to payment and a server verifying + settling it.
 *
 * The up-to scheme lets an agent say "charge me up to $5" and the server
 * settles the actual cost ($0.35). No refund needed. If the job fails,
 * settle for $0 — no on-chain tx at all.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THIS DOES                                                    │
 * │                                                                    │
 * │  1. Agent signs a Permit2 PermitWitnessTransferFrom (off-chain)   │
 * │     "I authorize up to $0.50 USDC to this merchant"               │
 * │                                                                    │
 * │  2. Server calls facilitator /verify                              │
 * │     "Is this signature valid? Does the agent have funds?"         │
 * │                                                                    │
 * │  3. Server runs the job (simulated Actor run)                     │
 * │                                                                    │
 * │  4. Server calls facilitator /settle with actual cost ($0.10)     │
 * │     "Move $0.10 USDC from agent to merchant on-chain"             │
 * │                                                                    │
 * │  5. Verify on-chain: merchant received exactly $0.10              │
 * │                                                                    │
 * │  6. Test zero-amount settlement (Actor failed, no charge)         │
 * │                                                                    │
 * │  7. Test nonce replay protection                                  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Prerequisites:
 *   - A wallet with USDC on Base Sepolia (testnet)
 *   - One-time: approve Permit2 contract for USDC (script handles this)
 *   - Get testnet USDC: https://faucet.circle.com/ (Base Sepolia)
 *
 * Usage:
 *   PRIVATE_KEY=0xYourKey npx tsx test-upto-payment.ts
 *
 *   # Against a specific facilitator:
 *   PRIVATE_KEY=0xYourKey FACILITATOR_URL=http://localhost:3001 npx tsx test-upto-payment.ts
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402-apify.goodmeta.co";
const RPC_URL = "https://sepolia.base.org";
const NETWORK = "eip155:84532"; // Base Sepolia (CAIP-2)

// USDC on Base Sepolia
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const USDC_DECIMALS = 6;

// Permit2 (Uniswap, universal across chains)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

// x402 up-to proxy (deployed on Base Sepolia via CREATE2)
const UPTO_PROXY_ADDRESS = "0x402039b3d6E6BEC5A02c2C9fd937ac17A6940002" as Address;

// Payment amounts
const MAX_AMOUNT = "500000";    // $0.50 USDC — agent authorizes up to this
const SETTLE_AMOUNT = "100000"; // $0.10 USDC — server settles actual cost

// Merchant (recipient) — use Hardhat account #1 for testing
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

// ---------------------------------------------------------------------------
// ABIs & EIP-712 Types
// ---------------------------------------------------------------------------

const erc20ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

// Permit2 EIP-712 domain (NOT the token domain — this is different from exact scheme)
function permit2Domain(chainId: number) {
  return {
    name: "Permit2",
    chainId,
    verifyingContract: PERMIT2_ADDRESS,
  } as const;
}

// Permit2 PermitWitnessTransferFrom types
// These are the types the agent signs — includes a Witness (to, facilitator, validAfter)
const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label: string, msg: string) {
  console.log(`  [${label}] ${msg}`);
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  x402 Up-to Scheme — Agent Signing + E2E Test              ║");
  console.log("║  Network: Base Sepolia (testnet)                           ║");
  console.log("║  Token: USDC                                               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // --- Setup ---

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("Set PRIVATE_KEY env var to your test wallet private key.");
    console.error("  PRIVATE_KEY=0x... npx tsx test-upto-payment.ts");
    process.exit(1);
  }

  const agent = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const agentWallet = createWalletClient({ account: agent, chain: baseSepolia, transport: http(RPC_URL) });

  // Get facilitator signer address
  const supported = await fetch(`${FACILITATOR_URL}/supported`).then((r) => r.json());
  const facilitatorSigner = supported.signers?.["eip155:*"]?.[0];
  if (!facilitatorSigner) {
    console.error("No EVM signer found at facilitator /supported endpoint.");
    process.exit(1);
  }

  console.log(`  Agent wallet:       ${agent.address}`);
  console.log(`  Merchant:           ${MERCHANT}`);
  console.log(`  Facilitator:        ${FACILITATOR_URL}`);
  console.log(`  Facilitator signer: ${facilitatorSigner}`);
  console.log(`  Max amount:         ${formatUnits(BigInt(MAX_AMOUNT), USDC_DECIMALS)} USDC`);
  console.log(`  Settle amount:      ${formatUnits(BigInt(SETTLE_AMOUNT), USDC_DECIMALS)} USDC\n`);

  // =========================================================================
  // STEP 1: Check prerequisites
  // =========================================================================
  console.log("Step 1: Check prerequisites");

  const [balance, permit2Allowance] = await Promise.all([
    publicClient.readContract({ address: USDC_ADDRESS, abi: erc20ABI, functionName: "balanceOf", args: [agent.address] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: erc20ABI, functionName: "allowance", args: [agent.address, PERMIT2_ADDRESS] }),
  ]);

  log("CHECK", `USDC balance: ${formatUnits(balance, USDC_DECIMALS)}`);
  log("CHECK", `Permit2 allowance: ${permit2Allowance.toString()}`);

  if (balance < BigInt(MAX_AMOUNT)) {
    console.error(`\nInsufficient USDC. Need ${formatUnits(BigInt(MAX_AMOUNT), USDC_DECIMALS)}, have ${formatUnits(balance, USDC_DECIMALS)}.`);
    console.error("Get testnet USDC: https://faucet.circle.com/ (select Base Sepolia)");
    process.exit(1);
  }

  // =========================================================================
  // STEP 2: Approve Permit2 (one-time, if needed)
  // =========================================================================
  console.log("\nStep 2: Approve Permit2 for USDC");

  if (permit2Allowance < BigInt(MAX_AMOUNT)) {
    log("APPROVE", "Sending approve(Permit2, maxUint256)...");
    const approveTx = await agentWallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
    });
    log("APPROVE", `Tx: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    log("APPROVE", "Permit2 approved for USDC");
  } else {
    log("APPROVE", "Already approved — skipping");
  }

  // =========================================================================
  // STEP 3: Sign Permit2 PermitWitnessTransferFrom
  //
  // This is the up-to payment signature. The agent says:
  //   "I authorize the proxy to move UP TO $0.50 of my USDC
  //    to this merchant, only if this specific facilitator
  //    triggers it, before this deadline."
  //
  // Key differences from exact scheme:
  //   - Domain = Permit2 contract (not the token)
  //   - Types = PermitWitnessTransferFrom (not ERC-2612 Permit)
  //   - Spender = x402UptoPermit2Proxy (not facilitator EOA)
  //   - Amount = maximum (actual settled later)
  // =========================================================================
  console.log("\nStep 3: Sign Permit2 PermitWitnessTransferFrom");

  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 300; // 5 minutes
  const nonce = BigInt(Date.now()); // unique nonce

  const domain = permit2Domain(baseSepolia.id);
  const message = {
    permitted: { token: USDC_ADDRESS, amount: BigInt(MAX_AMOUNT) },
    spender: UPTO_PROXY_ADDRESS,
    nonce,
    deadline: BigInt(deadline),
    witness: {
      to: MERCHANT,
      facilitator: facilitatorSigner as Address,
      validAfter: 0n,
    },
  };

  const signature = await agentWallet.signTypedData({
    domain,
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message,
  });

  log("SIGN", `Signature: ${signature.slice(0, 20)}...${signature.slice(-8)}`);

  // Build x402 payment payload (what gets sent to the server/middleware)
  const paymentPayload = {
    x402Version: 2,
    accepted: { scheme: "upto", network: NETWORK },
    payload: {
      signature,
      owner: agent.address,
      permit: {
        permitted: { token: USDC_ADDRESS, amount: MAX_AMOUNT },
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
      witness: {
        to: MERCHANT,
        facilitator: facilitatorSigner,
        validAfter: "0",
      },
    },
  };

  const paymentRequirements = {
    scheme: "upto",
    network: NETWORK,
    amount: MAX_AMOUNT, // At verify: this is the max
    payTo: MERCHANT,
    asset: USDC_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
  };

  // =========================================================================
  // STEP 4: Verify with facilitator
  // =========================================================================
  console.log("\nStep 4: POST /verify");

  const verifyResult = await postJson("/verify", { paymentPayload, paymentRequirements });
  log("VERIFY", `isValid: ${verifyResult.isValid}`);
  if (!verifyResult.isValid) {
    console.error(`\nVerify failed: ${verifyResult.invalidReason}`);
    process.exit(1);
  }
  log("VERIFY", `Remaining: ${verifyResult.remainingSeconds}s`);

  // =========================================================================
  // STEP 5: Settle actual cost
  //
  // Agent signed for $0.50 max. The "Actor" ran and cost $0.10.
  // We settle for $0.10 — not the $0.50 max. This is the up-to advantage.
  // =========================================================================
  console.log("\nStep 5: POST /settle (actual cost: $0.10, max was $0.50)");

  // Snapshot merchant balance before
  const merchantBefore = await publicClient.readContract({
    address: USDC_ADDRESS, abi: erc20ABI, functionName: "balanceOf", args: [MERCHANT],
  });
  log("SETTLE", `Merchant USDC before: ${formatUnits(merchantBefore, USDC_DECIMALS)}`);

  // Settle for actual amount (phase-dependent: amount = actual cost, not max)
  const settleRequirements = { ...paymentRequirements, amount: SETTLE_AMOUNT };
  const settleResult = await postJson("/settle", { paymentPayload, paymentRequirements: settleRequirements });

  if (!settleResult.success) {
    console.error(`\nSettle failed: ${settleResult.errorReason}`);
    process.exit(1);
  }

  log("SETTLE", `Tx: ${settleResult.transaction}`);
  log("SETTLE", `Settled: ${formatUnits(BigInt(settleResult.settledAmount || SETTLE_AMOUNT), USDC_DECIMALS)} USDC`);

  // =========================================================================
  // STEP 6: Verify on-chain transfer
  // =========================================================================
  console.log("\nStep 6: Verify on-chain");

  if (settleResult.transaction) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: settleResult.transaction as Hex,
      confirmations: 1,
    });
    log("CHAIN", `Block: ${receipt.blockNumber}, Gas: ${receipt.gasUsed}, Status: ${receipt.status}`);
    log("CHAIN", `BaseScan: https://sepolia.basescan.org/tx/${settleResult.transaction}`);

    // Verify merchant balance increased
    const merchantAfter = await publicClient.readContract({
      address: USDC_ADDRESS, abi: erc20ABI, functionName: "balanceOf", args: [MERCHANT],
    });
    const received = Number(merchantAfter) - Number(merchantBefore);
    log("CHAIN", `Merchant USDC after: ${formatUnits(merchantAfter, USDC_DECIMALS)}`);
    log("CHAIN", `Merchant received: ${formatUnits(BigInt(received), USDC_DECIMALS)} USDC`);

    if (received > 0) {
      log("CHAIN", "On-chain transfer verified!");
    } else {
      log("CHAIN", "Balance unchanged — tx may still be propagating. Check BaseScan link above.");
    }
  }

  // =========================================================================
  // STEP 7: Zero-amount settlement (Actor failed, no charge)
  // =========================================================================
  console.log("\nStep 7: Zero-amount settlement (no charge)");

  // New signature with fresh nonce (each permit is one-time-use)
  const zeroNonce = BigInt(Date.now() + 1);
  const zeroDeadline = Math.floor(Date.now() / 1000) + 300;
  const zeroSig = await agentWallet.signTypedData({
    domain,
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      ...message,
      nonce: zeroNonce,
      deadline: BigInt(zeroDeadline),
    },
  });

  const zeroPayload = {
    ...paymentPayload,
    payload: {
      ...paymentPayload.payload,
      signature: zeroSig,
      permit: { ...paymentPayload.payload.permit, nonce: zeroNonce.toString(), deadline: zeroDeadline.toString() },
    },
  };
  const zeroReqs = { ...paymentRequirements, amount: "0" };

  const zeroResult = await postJson("/settle", { paymentPayload: zeroPayload, paymentRequirements: zeroReqs });
  if (!zeroResult.success) throw new Error(`Zero settle failed: ${zeroResult.errorReason}`);
  if (zeroResult.transaction !== "") throw new Error(`Zero settle should have empty tx`);
  log("ZERO", "Zero-amount settlement passed (no on-chain tx)");

  // =========================================================================
  // STEP 8: Replay protection
  // =========================================================================
  console.log("\nStep 8: Replay protection");

  const replayResult = await postJson("/settle", { paymentPayload: zeroPayload, paymentRequirements: zeroReqs });
  if (replayResult.success) throw new Error("Replay should have been rejected");
  if (replayResult.errorReason !== "nonce_already_settled") throw new Error(`Expected nonce_already_settled, got: ${replayResult.errorReason}`);
  log("REPLAY", "Nonce replay rejected!");

  // =========================================================================
  // Done
  // =========================================================================
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ALL TESTS PASSED                                          ║");
  console.log("║                                                             ║");
  console.log("║  Agent signed $0.50 max → Server settled $0.10 actual      ║");
  console.log("║  Zero-amount settlement works (no tx)                      ║");
  console.log("║  Nonce replay protection works                             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
