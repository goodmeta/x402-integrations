# x402 Integrations

Production-ready x402 payment integrations for API infrastructure.

x402 is an HTTP-native payment protocol for AI agents. Instead of provisioning accounts and API keys, an agent hits an endpoint, receives a `402 Payment Required` with USDC payment instructions, signs a gasless permit, and retries with the signed payment. No human in the loop.

This repo contains reference implementations and end-to-end tests.

## Integrations

| Pattern | Stack | Status |
|---------|-------|--------|
| [Zuplo inbound policy](./zuplo/) | TypeScript, Cloudflare Workers | Production-ready |
| [E2E payment tests](./e2e/) | TypeScript, viem | Production-ready |

## Examples

| Example | API | Notes |
|---------|-----|-------|
| [Tavily search](./examples/tavily-search/) | Tavily Search API | Search gated by x402 |
| [E2B sandbox](./examples/e2b-sandbox/) | E2B Sandbox API | Code execution gated by x402 |
| [Exa search](./examples/exa-search/) | Exa Search API | Semantic search gated by x402 |

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

The facilitator handles signature verification and on-chain settlement. You don't need to interact with the blockchain directly.

## E2E Tests

The `e2e/` directory contains integration tests that exercise the full payment flow against a live facilitator:

- **`test-permit.ts`** — SBC token permit flow (Base Sepolia)
- **`test-apify-actor-payment.ts`** — USDC Actor payment flow simulating the Apify integration pattern

```bash
cd e2e && npm install
PRIVATE_KEY=0x... npm test           # SBC token
PRIVATE_KEY=0x... npm run test:apify # USDC (Apify flow)
```

## Facilitators

- [Coinbase x402 Facilitator](https://x402.org) — Base mainnet
- [SBC Facilitator](https://x402.stablecoin.xyz) — Base + Solana + Radius (USDC + SBC)

## Token Domains (EIP-712)

The ERC-2612 permit signature includes an EIP-712 domain. The `name` and `version` fields **must** match the on-chain token contract values:

| Token | Network | `name` | `version` |
|-------|---------|--------|-----------|
| USDC | Base Mainnet (eip155:8453) | `USD Coin` | `2` |
| USDC | Base Sepolia (eip155:84532) | `USDC` | `2` |
| SBC | Base Mainnet / Sepolia | `Stable Coin` | `1` |

Using the wrong domain name produces a valid-looking signature that fails on-chain.

## Built by

[Good Meta](https://goodmeta.co) — x402 integrations for API infrastructure companies.
