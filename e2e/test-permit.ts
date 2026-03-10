/**
 * End-to-end x402 v2 test — CLIENT SIDE (the paying agent)
 *
 * While the other examples in this repo show the SERVER side (how to gate
 * your API behind payments), this test shows the CLIENT side — how an
 * agent constructs and sends a payment.
 *
 * This test runs against the live SBC facilitator on Base Sepolia (testnet).
 * It performs the full v2 flow:
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  WHAT THIS TEST DOES (x402 v2 client flow)                        │
 * │                                                                    │
 * │  1. Check token balance (do we have enough to pay?)               │
 * │  2. Get the permit nonce from the token contract                  │
 * │  3. Sign an ERC-2612 Permit (authorize token spend, no gas)       │
 * │  4. Build the x402 v2 payment payload                             │
 * │  5. POST /verify — ask facilitator "is this signature valid?"     │
 * │  6. POST /settle — ask facilitator "execute the transfer now"     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IS AN ERC-2612 PERMIT?
 *
 * Normally, to let someone spend your tokens, you'd call `approve()` on
 * the token contract — which costs gas (a blockchain transaction fee).
 * ERC-2612 adds a `permit()` function that accepts a cryptographic
 * signature instead. The agent signs a message off-chain (free, instant),
 * and the facilitator submits the `permit()` + `transferFrom()` on-chain
 * (the facilitator pays the gas, not the agent).
 *
 * Usage:
 *   PRIVATE_KEY=0x... pnpm test
 *
 * Requirements:
 *   - A wallet with SBC testnet tokens on Base Sepolia
 *   - Token: 0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16 (SBC, 6 decimals)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The facilitator service that verifies and settles payments */
const FACILITATOR_URL = "https://x402.stablecoin.xyz";

/**
 * CAIP-2 network identifier for Base Sepolia (testnet).
 * We use a testnet so no real money is involved.
 * In production, you'd use "eip155:8453" (Base mainnet).
 */
const NETWORK = "eip155:84532"; // Base Sepolia

/**
 * The SBC test token contract address on Base Sepolia.
 * This is an ERC-20 token with ERC-2612 Permit support (6 decimals).
 * In production, you'd use USDC or another stablecoin.
 */
const SBC_TOKEN = "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16";
const SBC_DECIMALS = 6;

/**
 * The facilitator's signer address — this is who the Permit authorizes
 * to spend tokens. The facilitator uses this address to submit the
 * on-chain transaction. Retrieved from the facilitator's /supported endpoint.
 */
const FACILITATOR_SIGNER = "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6";

/** Test merchant wallet — where tokens are sent after settlement */
const MERCHANT_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/**
 * Amount to pay in token base units.
 * "1000" with 6 decimals = 0.001 SBC
 */
const AMOUNT = "1000";

/**
 * Define the Base Sepolia chain for viem (the Ethereum library).
 * This tells viem which RPC endpoint to use for blockchain calls.
 */
const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
  },
  testnet: true,
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load the wallet's private key from environment variable.
  // The private key is what lets us sign the Permit — it proves we own the wallet.
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("Set PRIVATE_KEY environment variable");
    console.error("   Usage: PRIVATE_KEY=0x... pnpm test");
    process.exit(1);
  }

  // Create an "account" from the private key — this gives us the wallet address
  // and the ability to sign messages.
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`\nWallet: ${account.address}`);

  // publicClient = read-only blockchain access (check balances, read contracts)
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  // walletClient = can sign transactions and messages (needs private key)
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  // -------------------------------------------------------------------------
  // Step 1: Check SBC balance
  //
  // Call the token contract's `balanceOf()` function to see how many
  // SBC tokens our wallet holds. This is a free read (no gas needed).
  // -------------------------------------------------------------------------
  console.log(`\nStep 1: Checking SBC balance on Base Sepolia...`);
  const balance = await publicClient.readContract({
    address: SBC_TOKEN as `0x${string}`,
    // ABI = Application Binary Interface — tells viem how to call the contract.
    // balanceOf(address) returns the token balance of that address.
    abi: [
      {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    functionName: "balanceOf",
    args: [account.address],
  });

  // formatUnits converts raw units to human-readable (e.g., 1000 → "0.001")
  console.log(
    `   Balance: ${balance.toString()} (${formatUnits(balance, SBC_DECIMALS)} SBC)`
  );

  if (balance < BigInt(AMOUNT)) {
    console.error(
      `\nInsufficient balance. Need at least ${AMOUNT} (${formatUnits(BigInt(AMOUNT), SBC_DECIMALS)} SBC)`
    );
    console.error(`   Token contract: ${SBC_TOKEN}`);
    console.error(`   Network: Base Sepolia (chain ID 84532)`);
    console.error(`   Get test tokens from the team or a faucet.`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Step 2: Get permit nonce
  //
  // Each Permit signature includes a "nonce" — a counter that prevents
  // replay attacks (using the same signature twice). The nonce auto-
  // increments on-chain each time a permit is used.
  // -------------------------------------------------------------------------
  console.log(`\nStep 2: Getting permit nonce...`);
  const nonce = await publicClient.readContract({
    address: SBC_TOKEN as `0x${string}`,
    abi: [
      {
        inputs: [{ name: "owner", type: "address" }],
        name: "nonces",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    functionName: "nonces",
    args: [account.address],
  });
  console.log(`   Nonce: ${nonce.toString()}`);

  // -------------------------------------------------------------------------
  // Step 3: Sign ERC-2612 Permit
  //
  // This is the core of x402 — we sign a structured message (EIP-712)
  // that says: "I authorize [facilitator] to spend [amount] of my [token]
  // before [deadline]."
  //
  // Key points:
  // - This is FREE — no gas, no on-chain transaction, just a signature
  // - The signature is specific to this token, chain, amount, and deadline
  // - Only the facilitator (spender) can use this signature
  // - It expires at the deadline — can't be used after that
  //
  // The `domain` fields MUST match what's in the token contract:
  //   name: "Stable Coin"  — the token's EIP-712 domain name
  //   version: "1"         — the token's EIP-712 domain version
  //   chainId: 84532       — Base Sepolia
  //   verifyingContract    — the token contract itself
  // -------------------------------------------------------------------------
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 minutes from now
  console.log(`\nStep 3: Signing ERC-2612 Permit...`);
  console.log(`   Owner (us): ${account.address}`);
  console.log(`   Spender (facilitator): ${FACILITATOR_SIGNER}`);
  console.log(`   Value: ${AMOUNT} (${formatUnits(BigInt(AMOUNT), SBC_DECIMALS)} SBC)`);
  console.log(`   Deadline: ${deadline.toString()} (${new Date(Number(deadline) * 1000).toISOString()})`);

  const signature = await walletClient.signTypedData({
    account,
    // EIP-712 domain — must match the token contract exactly
    domain: {
      name: "Stable Coin",
      version: "1",
      chainId: 84532,
      verifyingContract: SBC_TOKEN as `0x${string}`,
    },
    // The Permit type definition — standard ERC-2612 fields
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    // The actual values being signed
    message: {
      owner: account.address,             // who owns the tokens
      spender: FACILITATOR_SIGNER as `0x${string}`, // who can spend them
      value: BigInt(AMOUNT),               // how many tokens
      nonce: nonce,                        // replay protection
      deadline: deadline,                  // expiration time
    },
  });

  console.log(`   Signature: ${signature.slice(0, 20)}...`);

  // -------------------------------------------------------------------------
  // Step 4: Build x402 v2 payload
  //
  // Package the signature + authorization details into the x402 v2 format.
  // This is what gets sent to the server (or directly to the facilitator
  // in this test).
  //
  // In a real flow, this would be base64-encoded and sent as the
  // PAYMENT-SIGNATURE header on an API request.
  //
  // v2 payload structure:
  //   x402Version: 2       — protocol version
  //   accepted:            — which payment scheme/network was used
  //   payload.signature:   — the ERC-2612 Permit signature
  //   payload.authorization: — the permit parameters (who, how much, etc.)
  // -------------------------------------------------------------------------
  const paymentPayload = {
    x402Version: 2,
    resource: "https://api.example.com/test",
    accepted: {
      scheme: "exact",
      network: NETWORK,
    },
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: FACILITATOR_SIGNER,
        value: AMOUNT,
        validAfter: "0",
        validBefore: deadline.toString(),
        nonce: nonce.toString(),
      },
    },
  };

  /**
   * Payment requirements — what the "merchant" (API server) expects.
   * In a real flow, you'd get this from the 402 response body.
   * Here we construct it manually for testing.
   */
  const paymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT,
    resource: "https://api.example.com/test",
    payTo: MERCHANT_WALLET,
    asset: SBC_TOKEN,
    maxTimeoutSeconds: 300,
    extra: {
      name: "Stable Coin",
      version: "1",
    },
  };

  // -------------------------------------------------------------------------
  // Step 5: Verify with facilitator
  //
  // Ask the facilitator: "Is this payment signature valid?"
  // It checks the cryptographic signature, amount, expiration, and balance.
  // No tokens move yet — this is just validation.
  // -------------------------------------------------------------------------
  console.log(`\nStep 5: POST ${FACILITATOR_URL}/verify`);
  const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });

  const verifyResult = await verifyRes.json();
  console.log(`   Response:`, JSON.stringify(verifyResult, null, 2));

  if (!verifyResult.isValid) {
    console.error(`\nVerification failed: ${verifyResult.invalidReason}`);
    process.exit(1);
  }

  console.log(`\nVerification passed! Payer: ${verifyResult.payer}`);

  // -------------------------------------------------------------------------
  // Step 6: Settle with facilitator (v2 only)
  //
  // THIS IS WHERE TOKENS ACTUALLY MOVE.
  //
  // The facilitator takes our Permit signature and submits an on-chain
  // transaction that:
  //   1. Calls permit() — authorizes the facilitator to spend our tokens
  //   2. Calls transferFrom() — moves tokens from us to the merchant
  //
  // The facilitator pays the gas fee for this transaction.
  // We get back a transaction hash that can be verified on a block explorer.
  //
  // In v1, this step didn't exist — verify was the end of the flow.
  // v2 adds settlement to actually complete the payment on-chain.
  // -------------------------------------------------------------------------
  console.log(`\nStep 6: POST ${FACILITATOR_URL}/settle`);
  const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });

  const settleResult = await settleRes.json();
  console.log(`   Response:`, JSON.stringify(settleResult, null, 2));

  if (!settleResult.success) {
    console.error(`\nSettlement failed: ${settleResult.error || settleResult.errorReason}`);
    // Still a partial success — verify worked
    console.log(`\nVerify passed, settle failed. This may be a facilitator wallet issue (needs gas/tokens).`);
    process.exit(1);
  }

  const txHash = settleResult.txHash || settleResult.transaction;
  console.log(`\nSettlement successful!`);
  console.log(`   TX: ${txHash}`);
  console.log(`   Explorer: https://sepolia.basescan.org/tx/${txHash}`);

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`END-TO-END TEST PASSED`);
  console.log(`   Network: Base Sepolia`);
  console.log(`   Token: SBC (${SBC_TOKEN})`);
  console.log(`   Amount: ${formatUnits(BigInt(AMOUNT), SBC_DECIMALS)} SBC`);
  console.log(`   Payer: ${account.address}`);
  console.log(`   Merchant: ${MERCHANT_WALLET}`);
  console.log(`   Facilitator: ${FACILITATOR_URL}`);
  console.log(`   TX: ${txHash}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
