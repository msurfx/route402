# routex402

On-chain reputation layer for AI agent payments on Solana.

Check any seller's trust score before paying. Every x402 purchase builds verifiable, on-chain reputation that any agent can query.

## Install

```bash
npm install routex402
```

## Quick start

```typescript
import { Routex402 } from "routex402";

const r = new Routex402();

// Check reputation before paying
const rep = await r.checkReputation("SELLER_ADDRESS");
console.log(rep.reputation.score);     // 0-100
console.log(rep.tier);                 // "Elite" | "Trusted" | "New"
console.log(rep.recommendation);       // "proceed" | "caution"

// Quick trust check
if (await r.isTrusted("SELLER_ADDRESS")) {
  // safe to pay
}
```

## API

### `new Routex402(options?)`

| Option | Default | Description |
|--------|---------|-------------|
| `baseUrl` | `https://route402-seller.onrender.com` | Seller service URL |
| `timeout` | `10000` | Request timeout in ms |

### `checkReputation(address)`

Returns on-chain reputation for a seller: score, success rate, tier, and a proceed/caution recommendation.

```typescript
const rep = await r.checkReputation("5gseLV...");
// {
//   address: "5gseLV...",
//   reputation: {
//     score: 95,
//     completedCount: 47,
//     failedCount: 2,
//     successRate: 95.9,
//     totalVolume: 470000,
//     distinctBuyers: 12,
//     lastUpdated: 1731234567,
//     lastUpdatedDaysAgo: 1
//   },
//   tier: "Elite",
//   recommendation: "proceed",
//   evidence: "https://solscan.io/account/..."
// }
```

### `isTrusted(address, minScore?, minCompleted?)`

Quick boolean check. Returns `true` if the seller meets your thresholds.

```typescript
// Default: score >= 80, completed >= 5
if (await r.isTrusted("SELLER_ADDRESS")) { ... }

// Custom thresholds
if (await r.isTrusted("SELLER_ADDRESS", 90, 10)) { ... }
```

### `getAgentDetail(address, policy?)`

Full vetting report with individual checks and a pay/don't-pay decision.

```typescript
const detail = await r.getAgentDetail("SELLER_ADDRESS", "strict");
// detail.checks — array of vetting checks (track record, success rate, buyer independence, etc.)
// detail.decision.recommendation — "proceed" or "do_not_pay"
// detail.decision.blockReasons — why it's blocked (if any)
```

### `listAgents(options?)`

List all registered agents with optional filters.

```typescript
const result = await r.listAgents({ minScore: 80, tier: "Elite", limit: 10 });
// result.agents — array of agent profiles
```

### `getStats()`

Network-wide aggregates.

```typescript
const stats = await r.getStats();
// stats.agents, stats.totalPayments, stats.totalVolume, etc.
```

## Integration example

```typescript
import { Routex402 } from "routex402";

const routex = new Routex402();

async function buyService(sellerAddress: string) {
  // 1. Check reputation
  const rep = await routex.checkReputation(sellerAddress);
  
  if (rep.recommendation !== "proceed") {
    console.log(`Skipping ${sellerAddress} — reputation too low (${rep.reputation.score})`);
    return;
  }

  // 2. Make x402 purchase (your payment logic)
  const result = await makePayment(sellerAddress);
  
  // 3. The seller records reputation on-chain automatically
  console.log(`Paid ${sellerAddress} (${rep.tier} tier, ${rep.reputation.score} score)`);
}
```

## Links

- **Live demo:** [routex402.xyz](https://routex402.xyz)
- **GitHub:** [msurfx/route402](https://github.com/msurfx/route402)
- **On-chain program:** `6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt` (Solana devnet)

## License

MIT
