# Tavily Search — x402 Integration Example

This example wraps the [Tavily Search API](https://tavily.com) with x402 payment gating.

An agent that discovers this endpoint mid-task can pay in USDC and get search results — no Tavily account, no API key, no human in the loop.

## How it works

```
Agent → POST /search { "query": "ai agents" }
        No X-PAYMENT header

Server → 402 Payment Required
         {
           x402Version: 1,
           accepts: [{
             scheme: "exact",
             network: "eip155:8453",        // Base mainnet
             maxAmountRequired: "1000",      // 0.001 USDC per search
             payTo: "0xMerchantWallet",
             asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
           }]
         }

Agent → signs EIP-3009 authorization for 0.001 USDC
Agent → POST /search { "query": "ai agents" }
        X-PAYMENT: <base64 signed payload>

Server → verifies with facilitator
Server → calls Tavily API with stored key
Server → 200 OK { results: [...] }
```

## Run locally

```bash
cp .env.example .env
# Add your TAVILY_API_KEY and MERCHANT_WALLET to .env

pnpm install
pnpm dev
```

Then test the 402 response:

```bash
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "x402 payment protocol"}'
# → 402 with payment requirements
```

## Deploy

This runs as a Cloudflare Worker:

```bash
pnpm deploy
```

## Files

- `src/index.ts` — Worker entry point + x402 middleware
- `src/tavily.ts` — Tavily API client
- `wrangler.toml` — Cloudflare Worker config
