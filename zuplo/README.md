# x402 Zuplo Inbound Policy (v2)

An inbound [Zuplo](https://zuplo.com) policy that gates API routes behind x402 micropayments. Compatible with x402 v2 facilitators ([SBC](https://stablecoin.xyz), [Coinbase](https://x402.org)).

Drop it into any Zuplo route. Agents without payment get a `402`. Agents with a valid payment header pass through — the facilitator verifies the signature and settles on-chain.

## Install

Copy `src/policy.ts` into your Zuplo project's `policies/` directory. No additional dependencies required.

## Configure

In your `zuplo.json` route, add the policy as an inbound handler:

```json
{
  "path": "/v1/search",
  "methods": ["GET"],
  "handler": { "export": "urlForwardHandler", "module": "$import(@zuplo/runtime)" },
  "policies": {
    "inbound": [
      {
        "name": "x402-payment",
        "policyType": "custom-code-inbound",
        "handler": {
          "export": "default",
          "module": "$import(./policies/x402-policy)",
          "options": {
            "facilitatorUrl": "https://x402.stablecoin.xyz",
            "payTo": "0xYourWalletAddress",
            "network": "eip155:8453",
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "maxAmountRequired": "1000000",
            "description": "Access to search API",
            "maxTimeoutSeconds": 300,
            "tokenName": "USD Coin",
            "tokenVersion": "2"
          }
        }
      }
    ]
  }
}
```

## Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `facilitatorUrl` | string | Yes | — | Base URL of the x402 facilitator |
| `payTo` | string | Yes | — | Wallet address that receives payment |
| `network` | string | Yes | — | CAIP-2 chain ID, e.g. `eip155:8453` for Base |
| `asset` | string | Yes | — | ERC-20 token contract address |
| `maxAmountRequired` | string | Yes | — | Amount in token base units (`"1000000"` = 1 USDC) |
| `description` | string | No | `"Access to this API endpoint"` | Human-readable description in 402 body |
| `maxTimeoutSeconds` | number | No | `300` | Max seconds the payment authorization is valid |
| `tokenName` | string | No | `"Stable Coin"` | Token name for EIP-712 domain |
| `tokenVersion` | string | No | `"1"` | Token version for EIP-712 domain |
| `facilitatorAddress` | string | No | — | Facilitator contract address for EIP-712 domain |
| `settle` | boolean | No | `true` | Whether to settle payment on-chain after verification |

## How it works

```
Agent → request (no payment header)
         │
         ▼
┌─────────────────────────────────┐
│  Zuplo Gateway                  │
│                                 │
│  1. Check PAYMENT-SIGNATURE     │
│     (fallback: X-PAYMENT)       │
│     Missing → HTTP 402          │
│     + PAYMENT-REQUIRED header   │
│                                 │
│  2. Decode base64 → JSON        │
│                                 │
│  3. POST facilitator/verify     │
│     Invalid → HTTP 401          │
│                                 │
│  4. POST facilitator/settle     │
│     Failed → HTTP 402           │
│                                 │
│  5. Pass through to backend     │
└─────────────────────────────────┘
         │
         ▼
    Backend API responds
```

### Payment header format

The agent sends payment as a base64-encoded JSON string in the `PAYMENT-SIGNATURE` header (v2) or `X-PAYMENT` header (v1 backward compatible). The policy accepts both.

### 402 response format (v2)

```json
{
  "x402Version": 2,
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "1000000",
    "payTo": "0xYourWallet",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

The same body is also sent base64-encoded in the `PAYMENT-REQUIRED` response header for clients that prefer header-based discovery.

### Verify → Settle flow

After decoding the payment header, the policy makes two calls to the facilitator:

1. **POST /verify** — validates the cryptographic signature (ERC-2612 Permit for EVM, Ed25519 for Solana)
2. **POST /settle** — triggers on-chain token transfer

Set `settle: false` in options to skip settlement (verify-only mode, useful for testing).

## Response flow

| Condition | Status | Body |
|-----------|--------|------|
| No payment header | `402` | x402 v2 spec body + `PAYMENT-REQUIRED` header |
| Malformed header | `402` | Error message + payment requirements |
| Facilitator rejects payment | `401` | `{ error, reason }` |
| Settlement fails | `402` | `{ error, reason }` |
| Facilitator unreachable | `502` | Error message |
| Payment valid + settled | — | Request passes through to backend |

## Facilitators

| Facilitator | URL | Chains |
|-------------|-----|--------|
| [SBC](https://stablecoin.xyz) | `https://x402.stablecoin.xyz` | Base, Base Sepolia, Radius, Solana |
| [Coinbase](https://x402.org) | `https://x402.org` | Base |

## Test

```bash
cd zuplo
pnpm install
pnpm test
```

14 tests covering: no header (402), v2 header, v1 fallback, malformed header, verify+settle pass-through, settle skip, verify rejection, settle failure, facilitator unreachable (3 variants), and defaults.

## Tested against

- SBC facilitator (`x402.stablecoin.xyz`) — v2 payload format verified against live endpoint
- Unit tests with mocked facilitator covering all response paths
