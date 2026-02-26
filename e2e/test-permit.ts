/**
 * End-to-end x402 v2 test against the live SBC facilitator.
 *
 * Signs a real ERC-2612 Permit on Base Sepolia, sends it to the facilitator
 * for verification and settlement.
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

const FACILITATOR_URL = "https://x402.stablecoin.xyz";
const NETWORK = "eip155:84532"; // Base Sepolia
const SBC_TOKEN = "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16";
const SBC_DECIMALS = 6;
const FACILITATOR_SIGNER = "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6"; // from /supported
const MERCHANT_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // test merchant
const AMOUNT = "1000"; // 0.001 SBC (6 decimals)

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
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ Set PRIVATE_KEY environment variable");
    console.error("   Usage: PRIVATE_KEY=0x... pnpm test");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`\n🔑 Wallet: ${account.address}`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  // Step 1: Check SBC balance
  console.log(`\n📊 Checking SBC balance on Base Sepolia...`);
  const balance = await publicClient.readContract({
    address: SBC_TOKEN as `0x${string}`,
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

  console.log(
    `   Balance: ${balance.toString()} (${formatUnits(balance, SBC_DECIMALS)} SBC)`
  );

  if (balance < BigInt(AMOUNT)) {
    console.error(
      `\n❌ Insufficient balance. Need at least ${AMOUNT} (${formatUnits(BigInt(AMOUNT), SBC_DECIMALS)} SBC)`
    );
    console.error(`   Token contract: ${SBC_TOKEN}`);
    console.error(`   Network: Base Sepolia (chain ID 84532)`);
    console.error(`   Get test tokens from the team or a faucet.`);
    process.exit(1);
  }

  // Step 2: Get permit nonce
  console.log(`\n🔢 Getting permit nonce...`);
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

  // Step 3: Sign ERC-2612 Permit
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 minutes
  console.log(
    `\n✍️  Signing ERC-2612 Permit...`
  );
  console.log(`   Owner: ${account.address}`);
  console.log(`   Spender (facilitator): ${FACILITATOR_SIGNER}`);
  console.log(`   Value: ${AMOUNT} (${formatUnits(BigInt(AMOUNT), SBC_DECIMALS)} SBC)`);
  console.log(`   Deadline: ${deadline.toString()} (${new Date(Number(deadline) * 1000).toISOString()})`);

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: "Stable Coin",
      version: "1",
      chainId: 84532,
      verifyingContract: SBC_TOKEN as `0x${string}`,
    },
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
    message: {
      owner: account.address,
      spender: FACILITATOR_SIGNER as `0x${string}`,
      value: BigInt(AMOUNT),
      nonce: nonce,
      deadline: deadline,
    },
  });

  console.log(`   Signature: ${signature.slice(0, 20)}...`);

  // Step 4: Build x402 v2 payload
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

  // Step 5: Verify with facilitator
  console.log(`\n🔍 POST ${FACILITATOR_URL}/verify`);
  const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });

  const verifyResult = await verifyRes.json();
  console.log(`   Response:`, JSON.stringify(verifyResult, null, 2));

  if (!verifyResult.isValid) {
    console.error(`\n❌ Verification failed: ${verifyResult.invalidReason}`);
    process.exit(1);
  }

  console.log(`\n✅ Verification passed! Payer: ${verifyResult.payer}`);

  // Step 6: Settle with facilitator
  console.log(`\n💰 POST ${FACILITATOR_URL}/settle`);
  const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements }),
  });

  const settleResult = await settleRes.json();
  console.log(`   Response:`, JSON.stringify(settleResult, null, 2));

  if (!settleResult.success) {
    console.error(`\n❌ Settlement failed: ${settleResult.error || settleResult.errorReason}`);
    // Still a partial success — verify worked
    console.log(`\n⚠️  Verify passed, settle failed. This may be a facilitator wallet issue (needs gas/tokens).`);
    process.exit(1);
  }

  const txHash = settleResult.txHash || settleResult.transaction;
  console.log(`\n✅ Settlement successful!`);
  console.log(`   TX: ${txHash}`);
  console.log(`   Explorer: https://sepolia.basescan.org/tx/${txHash}`);

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ END-TO-END TEST PASSED`);
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
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
