# x402 Integrations

Production-ready x402 payment integrations for API infrastructure.

x402 is an HTTP-native payment protocol for AI agents. Instead of provisioning accounts and API keys, an agent hits an endpoint, receives a `402 Payment Required` with USDC payment instructions, signs a gasless permit, and retries with the signed payment. No human in the loop.

## Integrations

| Integration | Stack | Status |
|-------------|-------|--------|
| [Apify Actor payment](./apify/) | TypeScript, viem, USDC on Base | Production-ready |
| [Zuplo inbound policy](./zuplo/) | TypeScript, Cloudflare Workers | Production-ready |

## Apify E2E Test

Full Actor payment flow: check balance → sign permit → verify → Actor run → settle → on-chain tx.

```bash
cd apify/e2e && npm install
PRIVATE_KEY=0x... FACILITATOR_URL=https://x402-apify.goodmeta.co npm run test:apify
```

**What Apify builds (server side):** just HTTP POSTs to `/verify` and `/settle`. No blockchain code needed — the facilitator handles all on-chain operations.

**What the test simulates:** both sides (agent signing + server verifying/settling) so you can see the full flow end-to-end.

## Zuplo Policy

Drop-in inbound policy for API payment gating. 14 tests covering all edge cases.

```bash
cd zuplo && pnpm install && pnpm test
```

## How x402 Works

```
Agent  ->  GET /api/resource
Server ->  402 Payment Required
           { x402Version: 2, accepts: [{ scheme, network, amount, payTo, asset, extra }] }

Agent  ->  signs ERC-2612 Permit (off-chain, free)
Agent  ->  GET /api/resource + PAYMENT-SIGNATURE header
Server ->  POST /verify to facilitator (read-only check)
Server ->  200 OK + run the job
Server ->  POST /settle to facilitator (on-chain USDC transfer)
```

## Token Domains (EIP-712)

The ERC-2612 permit signature includes an EIP-712 domain. The `name` and `version` fields **must** match the on-chain token contract values:

| Token | Network | `name` | `version` |
|-------|---------|--------|-----------|
| USDC | Base Mainnet (eip155:8453) | `USD Coin` | `2` |
| USDC | Base Sepolia (eip155:84532) | `USDC` | `2` |

## Built by

[Good Meta](https://goodmeta.co) — x402 integrations for API infrastructure companies.
