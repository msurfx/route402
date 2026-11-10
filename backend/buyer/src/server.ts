import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import rateLimit from "express-rate-limit";
import { Keypair } from "@solana/web3.js";
import { runPurchase } from "./purchase.js";

const app = express();

// Security note (audit-driven fix): CORS is restricted to the actual
// frontend origins rather than the previous open default. This stops other
// websites from calling this API from a victim's browser; it does not stop
// direct curl/script access, which is why rate limiting below matters more.
// localhost entries are for local frontend dev only; harmless in prod because
// CORS stops browser requests — it does not stop curl/server-side callers.
const ALLOWED_ORIGINS: (string | RegExp)[] = [
  "https://routex402.xyz",
  "https://www.routex402.xyz",
  "https://route402.onrender.com",
  /^http:\/\/localhost(:\d+)?$/,
];
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] }));
app.use(express.json());
app.set("trust proxy", 1); // Render sits behind a proxy; needed for correct client IP

const PORT = Number(process.env.BUYER_SERVER_PORT ?? 4022);

// Fail fast at boot: confirm the buyer keypair actually loads before
// accepting any traffic, and log the pubkey (never the secret) so a
// misconfigured deploy dies loudly instead of erroring on the first request.
function loadBuyerPubkeyForBootCheck(): string {
  const fromEnv = process.env.BUYER_KEYPAIR_SECRET;
  if (fromEnv) {
    const secret = JSON.parse(fromEnv);
    return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
  }
  const path = process.env.BUYER_KEYPAIR_PATH ?? "./buyer-keypair.json";
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}
const buyerPubkey = loadBuyerPubkeyForBootCheck();
console.log(`Buyer wallet: ${buyerPubkey}`);

/**
 * Security note (see audit report): this server has two purchase-triggering
 * routes with different trust models, since the frontend is a static site
 * and has no way to hold a secret.
 *
 *   POST /demo-purchase — public, unauthenticated, for the site's "Run
 *     purchase" button. Tightly rate-limited (3/min/IP) since the URL is
 *     published in the frontend and reachable by anyone.
 *   POST /purchase — requires a shared secret (x-demo-token header)
 *     matching DEMO_API_TOKEN. Intended for real programmatic callers.
 *     Also rate-limited as defense in depth.
 *
 * Both sign and broadcast real transactions from this server's hot wallet.
 * Keep hosted wallet balances near-empty (see README) — the demo path is
 * unauthenticated-by-design only because these are disposable devnet keys.
 */

const DEMO_TOKEN = process.env.DEMO_API_TOKEN;
if (!DEMO_TOKEN) {
  console.error("FATAL: DEMO_API_TOKEN env var is not set. Set it before starting the server.");
  process.exit(1);
}

function requireToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!DEMO_TOKEN) {
    return res.status(500).json({ error: "server misconfigured: DEMO_API_TOKEN not set" });
  }
  const provided = req.get("x-demo-token");
  const ok = Boolean(provided) &&
    provided!.length === DEMO_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(provided!), Buffer.from(DEMO_TOKEN));
  if (!ok) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

const demoLimiter = rateLimit({
  windowMs: 60_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded, try again shortly" },
});

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded, try again shortly" },
});

async function handlePurchase(_req: express.Request, res: express.Response) {
  try {
    const outcome = await runPurchase();
    res.status(outcome.success ? 200 : 502).json(outcome);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message ?? "Unknown error" });
  }
}

app.post("/demo-purchase", demoLimiter, handlePurchase);
app.post("/purchase", apiLimiter, requireToken, handlePurchase);

// Multi-agent chain demo: 3 named agents run sequential x402 purchases
const AGENT_CHAIN = [
  { agent: "Coral Protocol", task: "price-oracle" },
  { agent: "SendAI",         task: "uptime-monitor" },
  { agent: "Swarms",         task: "whale-watcher" },
];

const chainLimiter = rateLimit({
  windowMs: 120_000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "chain demo rate limit — try again in 2 minutes" },
});

app.post("/demo-chain", chainLimiter, async (_req, res) => {
  const results: Array<{ agent: string; task: string; success: boolean; signature?: string; error?: string }> = [];
  for (const step of AGENT_CHAIN) {
    try {
      const outcome = await runPurchase(step.task, step.agent);
      results.push({
        agent: step.agent,
        task: step.task,
        success: outcome.success,
        signature: outcome.signature,
        error: outcome.success ? undefined : outcome.message,
      });
    } catch (err: any) {
      results.push({
        agent: step.agent,
        task: step.task,
        success: false,
        error: err?.message ?? "Unknown error",
      });
    }
  }
  const allOk = results.every((r) => r.success);
  res.status(allOk ? 200 : 207).json({ chain: results, allSuccess: allOk });
});

app.listen(PORT, () => {
  console.log(`Buyer demo server listening on http://localhost:${PORT}`);
  console.log(`POST /demo-purchase (public, rate-limited) or /purchase (token-gated) to trigger a purchase.`);
});
