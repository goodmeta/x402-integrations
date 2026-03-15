# x402 MCP Middleware for Apify

Reference implementation: x402 payment at the MCP `call-actor` level, with up-to scheme support.

## What's here

```
apify/
├── mcp-x402-middleware.ts          # Reusable middleware (the core)
├── example-call-actor-integration.ts # How to wire it into Apify's MCP server
├── example-transport-middleware.ts  # Bridge for mcp-cli's HTTP header flow
├── test-mcp-middleware.ts          # 48 tests (mock facilitator, no chain needed)
├── package.json
└── e2e/
    ├── test-apify-actor-payment.ts # Exact scheme E2E (Base Sepolia)
    └── test-upto-payment.ts        # Up-to scheme E2E (Base Sepolia)
```

## Quick start

```bash
# Run middleware tests (no wallet needed, no chain, runs in 2 seconds)
cd apify
npm install
npx tsx test-mcp-middleware.ts

# Run up-to E2E on Base Sepolia (needs funded wallet)
cd e2e
npm install
PRIVATE_KEY=0xYourKey npx tsx test-upto-payment.ts
```

## How it works

### The middleware (`mcp-x402-middleware.ts`)

Wraps any MCP tool handler with x402 payment. Two functions:

```typescript
import { createX402Middleware } from './mcp-x402-middleware';

const x402 = createX402Middleware({
  facilitatorUrl: 'https://x402-apify.goodmeta.co',  // swap to any facilitator
  payTo: '0xApifyWallet',
  getActorPricing: async (actorId) => ({ maxAmount: '5000000', scheme: 'upto' }),
  getActualCost: async (runResult) => runResult._runStats.totalCostUsdc,
});

// Augment schema (adds x402-payment to inputSchema, like applySkyfireAugmentation)
const schema = x402.augmentSchema(callActorSchema);

// Wrap handler (validates, strips payment, executes, settles)
const handler = x402.wrapHandler(existingCallActorHandler);
```

### The flow

```
Agent calls call-actor("apify/web-scraper", {url: "..."})
  │
  ├─ No payment?
  │   └─ Return x402 PaymentRequired (structuredContent + content)
  │      scheme: upto, maxAmount, facilitatorUrl, asset, payTo
  │
  ├─ Has payment?
  │   ├─ POST facilitator/verify → valid?
  │   │   ├─ No  → Return paymentInvalid + reason
  │   │   └─ Yes → Strip x402-payment from args
  │   │            → Execute Actor (existing handler)
  │   │              ├─ Fails → settle $0 (no charge)
  │   │              └─ Succeeds → calculate actual cost
  │   │                          → POST facilitator/settle
  │   │                          → Return results + receipt
  │   └─ Receipt in _meta["x402/payment-response"]
```

### Payment delivery (3 paths, priority order)

| Path | How | Works on |
|------|-----|----------|
| Tool argument | `args["x402-payment"]` | All transports, SDK v1+ (primary) |
| Request `_meta` | `params._meta["x402/payment"]` | SDK v2+ (x402 MCP spec) |
| HTTP header | `PAYMENT-SIGNATURE` header via transport middleware | Streamable HTTP (mcp-cli compat) |

Apify uses MCP SDK v1 (`^1.25.2`). On v1, only the tool argument path works natively. For mcp-cli's HTTP header flow, use the transport middleware (`example-transport-middleware.ts`) to extract the header and inject it into args.

### Pattern match with Skyfire

This follows the same pattern as Apify's existing Skyfire integration:

| Skyfire | x402 middleware |
|---------|----------------|
| `applySkyfireAugmentation()` adds `skyfire-pay-id` | `augmentSchema()` adds `x402-payment` |
| `validateSkyfirePayId()` checks `args` | `wrapHandler` checks `args["x402-payment"]` |
| Strips `skyfire-pay-id` before forwarding | Strips `x402-payment` before forwarding |
| `additionalProperties: true` passes AJV | Same — no validator changes needed |

### Integration with Apify's server

Apify uses `setRequestHandler(CallToolRequestSchema, ...)` with a custom tool map, not `server.tool()`. To integrate:

1. In `upsertTools()`: apply `x402.augmentSchema(tool.inputSchema)` (same spot as `applySkyfireAugmentation`)
2. In the CallToolRequestSchema handler: wrap execution with `x402.wrapHandler(tool.call)(args, extra)`
3. AJV validators already have `additionalProperties: true` — no changes needed

## Up-to scheme E2E

The up-to signing example (`e2e/test-upto-payment.ts`) is the first working reference for agent-side Permit2 signing. Tests:

1. Sign Permit2 PermitWitnessTransferFrom ("up to $0.50")
2. Verify with facilitator
3. Settle actual cost ($0.10) on-chain
4. Verify merchant received USDC
5. Zero-amount settlement (Actor failed, no charge)
6. Nonce replay protection

```bash
PRIVATE_KEY=0xYourKey npx tsx test-upto-payment.ts
# Or against a local facilitator:
PRIVATE_KEY=0xYourKey FACILITATOR_URL=http://localhost:3001 npx tsx test-upto-payment.ts
```

Prerequisites: wallet with USDC on Base Sepolia ([faucet](https://faucet.circle.com/)).

## Spec compliance

Follows x402 MCP transport spec (`specs/transports-v2/mcp.md`):
- 402 response uses `structuredContent` with `PaymentRequired` object
- Settlement receipt in `_meta["x402/payment-response"]`
- `isError: true` for payment required / failures
- Phase-dependent amount: verify = max, settle = actual

## Facilitator-agnostic

`facilitatorUrl` is a config param. Point it at any x402 facilitator that supports up-to:

```typescript
// Good Meta test facilitator (Base Sepolia)
facilitatorUrl: 'https://x402-apify.goodmeta.co'

// Coinbase (when they ship up-to)
facilitatorUrl: 'https://x402-facilitator.cdp.coinbase.com'

// Self-hosted
facilitatorUrl: 'http://localhost:3001'
```

No code changes needed to switch.
