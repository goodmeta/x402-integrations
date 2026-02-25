# x402 Integrations

Production-ready x402 payment integrations for API infrastructure.

x402 is an HTTP-native payment protocol for AI agents. Instead of provisioning accounts and API keys, an agent hits an endpoint, receives a `402 Payment Required` with USDC payment instructions, pays on-chain, and retries. No human in the loop.

This repo contains reference implementations for the most common integration patterns.

## Integrations

| Pattern | Stack | Status |
|---------|-------|--------|
| [Zuplo inbound policy](./zuplo/) | TypeScript, Cloudflare Workers | ✅ Production-ready |
| [Cloudflare Worker middleware](./cloudflare-workers/) | TypeScript, Cloudflare Workers | 🔨 In progress |
| [Express middleware](./express/) | TypeScript, Node.js | 🔨 In progress |
| [MCP server payment gating](./mcp/) | TypeScript | 🔨 In progress |

## Examples

| Example | API | Notes |
|---------|-----|-------|
| [Tavily search](./examples/tavily-search/) | Tavily Search API | Search gated by x402 |
| [E2B sandbox](./examples/e2b-sandbox/) | E2B Sandbox API | Code execution gated by x402 |
| [Exa search](./examples/exa-search/) | Exa Search API | Semantic search gated by x402 |

## Live Demo

`demo.goodmeta.co/search?q=ai+agents` — returns a real 402, pay in USDC on Base, get search results back. No account required.

## How x402 Works

```
Agent → GET /api/resource
Server → 402 Payment Required
         { x402Version: 1, accepts: [{ scheme, network, maxAmountRequired, payTo, asset }] }

Agent → signs EIP-3009 authorization
Agent → POST /api/resource (X-PAYMENT: <base64 signed payload>)
Server → verifies with facilitator → 200 OK
```

The facilitator handles signature verification and on-chain settlement. You don't need to interact with the blockchain directly.

## Facilitators

- [Coinbase x402 Facilitator](https://x402.org) — Base mainnet
- [SBC Facilitator](https://stablecoin.xyz) — Base + Solana + Radius

## Built by

[Good Meta](https://goodmeta.co) — x402 integrations for API infrastructure companies.
