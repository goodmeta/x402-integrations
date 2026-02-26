# x402 Zuplo Inbound Policy

An inbound [Zuplo](https://zuplo.com) policy that gates API routes behind x402 micropayments.

Drop it into any Zuplo route. Agents without payment get a `402`. Agents with a valid `X-PAYMENT` header pass through.

## Install

Copy `src/policy.ts` into your Zuplo project's `policies/` directory.

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
| `facilitatorUrl` | string | ✅ | — | Base URL of your x402 facilitator |
| `payTo` | string | ✅ | — | Wallet address that receives USDC |
| `network` | string | ✅ | — | CAIP-2 chain ID, e.g. `eip155:8453` for Base |
| `asset` | string | ✅ | — | ERC-20 token contract address |
| `maxAmountRequired` | string | ✅ | — | Amount in token base units (`"1000000"` = 1 USDC) |
| `description` | string | — | `"Access to this API endpoint"` | Human-readable description in 402 body |
| `maxTimeoutSeconds` | number | — | `300` | Max seconds the payment authorization is valid |
| `tokenName` | string | — | `"Stable Coin"` | Token name for EIP-712 domain |
| `tokenVersion` | string | — | `"1"` | Token version for EIP-712 domain |

## Response flow

| Condition | Status | Body |
|-----------|--------|------|
| No `X-PAYMENT` header | `402` | x402 spec body with payment requirements |
| Malformed header | `400` | Error message |
| Facilitator rejects payment | `401` | `{ error, reason }` |
| Facilitator unreachable | `502` | Error message |
| Payment valid | — | Request passes through to backend |

## Test

```bash
cd zuplo
pnpm install
pnpm test
```

9/9 tests passing.
