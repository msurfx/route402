import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Connection, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PORT, RPC_URL, USDC_MINT, SERVICE_PRICE } from "./config.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import {
  loadKeypair,
  recordFailure,
  listSellerProfiles,
  ensureSellerProfile,
  getProtocolConfig,
} from "./anchorClient.js";
import { performService, isSupportedTask, SUPPORTED_TASKS } from "./service.js";
import { createApiV1Router } from "./api-v1.js";
import idl from "./idl/agent_economy.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

const app = express();

const ALLOWED_ORIGINS: (string | RegExp)[] = [
  "https://routex402.xyz",
  "https://www.routex402.xyz",
  "https://route402.onrender.com",
  /^http:\/\/localhost(:\d+)?$/,
];
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] }));
app.use(express.json());
app.set("trust proxy", 1);

const serviceLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded, try again shortly" },
});

const sellerAuthority = loadKeypair(
  "SELLER_KEYPAIR_SECRET",
  process.env.SELLER_KEYPAIR_PATH ?? "./seller-keypair.json"
);

const connection = new Connection(RPC_URL, "confirmed");

const sellerTokenAccount = (
  await getOrCreateAssociatedTokenAccount(
    connection,
    sellerAuthority,
    USDC_MINT,
    sellerAuthority.publicKey
  )
).address.toBase58();

const profileState = await ensureSellerProfile(sellerAuthority, SERVICE_PRICE);
if (profileState !== "exists") {
  console.warn(
    `SellerProfile ${profileState === "migrated" ? "MIGRATED to new layout — counters reset to zero" : "created fresh"}`
  );
}

const protocolConfig = await getProtocolConfig(sellerAuthority);
const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 0;
console.log(`Protocol fee: ${protocolFeeBps} bps${protocolConfig ? "" : " (ProtocolConfig not initialized)"}`);

const seenSignatures = new Set<string>();

interface ActivityEvent {
  id: number;
  timestamp: string;
  step: string;
  message: string;
  signature?: string;
  agent?: string;
}
const events: ActivityEvent[] = [];
let eventId = 0;
function logEvent(step: string, message: string, signature?: string, agent?: string) {
  events.unshift({ id: eventId++, timestamp: new Date().toISOString(), step, message, signature, agent });
  if (events.length > 50) events.length = 50;
  const agentTag = agent ? `[${agent}]` : "";
  console.log(`[${step}]${agentTag} ${message}`);
}

app.get("/events", (_req, res) => {
  res.json(events);
});

app.post("/service", serviceLimiter, async (req, res) => {
  const { paymentSignature, task: requestedTask, params, agent: agentName } = req.body ?? {};
  const agent = typeof agentName === "string" ? agentName.slice(0, 30) : undefined;
  const task = requestedTask ?? "network-report";
  if (!isSupportedTask(task)) {
    logEvent("receive_request", `Rejected unknown task "${String(task).slice(0, 40)}"`, undefined, agent);
    return res.status(400).json({ error: "unsupported task", supportedTasks: SUPPORTED_TASKS });
  }

  if (!paymentSignature) {
    logEvent("receive_request", `${agent || "Buyer"} requested "${task}", no payment attached`, undefined, agent);
    logEvent("402_challenge", `Sent 402 — price ${buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps).amount} base units`, undefined, agent);
    return res.status(402).json({
      error: "payment required",
      paymentRequirements: buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps),
    });
  }

  logEvent("verify_payment", `Verifying signature ${paymentSignature.slice(0, 12)}...`, paymentSignature, agent);

  if (seenSignatures.has(paymentSignature)) {
    logEvent("verify_payment", "Rejected — signature already used", paymentSignature, agent);
    return res.status(409).json({ error: "payment signature already used" });
  }

  const result = await verifyPayment(paymentSignature, sellerTokenAccount);

  if (!result.ok) {
    logEvent("verify_payment", `Failed — ${result.reason}`, paymentSignature, agent);
    try {
      await recordFailure(sellerAuthority);
      logEvent("reputation_update", "Recorded failure on-chain (seller self-reported)", undefined, agent);
    } catch (err) {
      console.error("record_failure failed:", err);
      logEvent("reputation_update", "Failed to record failure on-chain", undefined, agent);
    }
    return res.status(402).json({
      error: "payment verification failed",
      reason: result.reason,
      paymentRequirements: buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps),
    });
  }

  logEvent("verify_payment", `Verified — ${result.amountPaid} base units received`, paymentSignature, agent);
  seenSignatures.add(paymentSignature);

  let output;
  try {
    output = await performService(connection, task, params);
  } catch (err) {
    console.error("service execution failed:", err);
    logEvent("deliver_result", `Failed to perform task "${task}" after verified payment`, undefined, agent);
    try {
      await recordFailure(sellerAuthority);
      logEvent("reputation_update", "Recorded failure on-chain (seller self-reported)", undefined, agent);
    } catch (recordErr) {
      console.error("record_failure failed:", recordErr);
      logEvent("reputation_update", "Failed to record failure on-chain", undefined, agent);
    }
    return res.status(500).json({ error: "service execution failed" });
  }

  // Build a human-readable deliver message per task type
  let deliverMsg: string;
  switch (task) {
    case "price-oracle":
      deliverMsg = `Delivered "${task}" (${output.data.pair} $${output.data.price}, slot ${output.data.slot})`;
      break;
    case "uptime-monitor":
      deliverMsg = `Delivered "${task}" (${output.data.status}, ${output.data.rpcLatencyMs}ms latency, slot ${output.data.slot})`;
      break;
    case "whale-watcher":
      deliverMsg = `Delivered "${task}" (top ${output.data.topAccounts?.length || 0} accounts, slot ${output.data.slot})`;
      break;
    case "validator-score":
      deliverMsg = `Delivered "${task}" (${output.data.activeValidators}/${output.data.totalValidators} active, slot ${output.data.slot})`;
      break;
    default:
      deliverMsg = `Delivered "${task}" (slot ${output.data.slot}, avg ${output.data.avgTps} TPS)`;
  }
  deliverMsg += " — buyer will record reputation on-chain";
  logEvent("deliver_result", deliverMsg, paymentSignature, agent);

  return res.status(200).json({
    task,
    result: output.summary,
    data: output.data,
    generatedAt: output.data.generatedAt,
    sellerAuthority: sellerAuthority.publicKey.toBase58(),
    amountPaid: result.amountPaid,
  });
});

// Free previews — lets the homepage show live agent data without paying.
const previewLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

app.get("/preview/price", previewLimiter, async (_req, res) => {
  try {
    const output = await performService(connection, "price-oracle", {});
    res.json({ task: "price-oracle", result: output.summary, data: output.data, preview: true });
  } catch (err) {
    console.error("price preview failed:", err);
    res.status(500).json({ error: "price preview unavailable" });
  }
});

app.get("/preview/uptime", previewLimiter, async (_req, res) => {
  try {
    const output = await performService(connection, "uptime-monitor", {});
    res.json({ task: "uptime-monitor", result: output.summary, data: output.data, preview: true });
  } catch (err) {
    console.error("uptime preview failed:", err);
    res.status(500).json({ error: "uptime preview unavailable" });
  }
});

app.get("/preview/whales", previewLimiter, async (_req, res) => {
  try {
    const output = await performService(connection, "whale-watcher", {});
    res.json({ task: "whale-watcher", result: output.summary, data: output.data, preview: true });
  } catch (err) {
    console.error("whale preview failed:", err);
    res.status(500).json({ error: "whale preview unavailable" });
  }
});

app.get("/preview/validators", previewLimiter, async (_req, res) => {
  try {
    const output = await performService(connection, "validator-score", {});
    res.json({ task: "validator-score", result: output.summary, data: output.data, preview: true });
  } catch (err) {
    console.error("validator preview failed:", err);
    res.status(500).json({ error: "validator preview unavailable" });
  }
});

app.get("/agents", async (_req, res) => {
  try {
    const profiles = await listSellerProfiles(sellerAuthority);
    profiles.sort((a: { reputationScore: number }, b: { reputationScore: number }) => b.reputationScore - a.reputationScore);
    res.json(profiles);
  } catch (err) {
    console.error("failed to list seller profiles:", err);
    res.status(500).json({ error: "could not load agent stats" });
  }
});

// Public reputation lookup — the core product endpoint
// Returns on-chain reputation, tier, confidence, vetting checks and a pay/don't-pay recommendation
app.get("/reputation/:address", async (req, res) => {
  try {
    const key = req.params.address;
    // Validate it looks like a base58 pubkey
    try { new PublicKey(key); } catch { return res.status(400).json({ error: "invalid Solana address" }); }

    const profiles = await listSellerProfiles(sellerAuthority);
    const agent = profiles.find((a: any) => a.pubkey === key || a.authority === key);
    if (!agent) return res.status(404).json({ error: "agent not found", address: key });

    const total = agent.completedCount + agent.failedCount;
    const successRate = total > 0 ? Number(((agent.completedCount / total) * 100).toFixed(1)) : 0;
    const ageDays = (Math.floor(Date.now() / 1000) - agent.lastUpdated) / 86400;

    res.json({
      address: key,
      reputation: {
        score: agent.reputationScore,
        completedCount: agent.completedCount,
        failedCount: agent.failedCount,
        successRate,
        totalVolume: agent.totalVolume,
        distinctBuyers: agent.distinctBuyers,
        lastUpdated: agent.lastUpdated,
        lastUpdatedDaysAgo: Math.floor(ageDays),
      },
      tier: agent.completedCount >= 15 && agent.reputationScore >= 90 ? "Elite"
          : agent.completedCount >= 5 && agent.reputationScore >= 70 ? "Trusted" : "New",
      recommendation: agent.reputationScore >= 80 && successRate >= 80 ? "proceed" : "caution",
      evidence: `https://solscan.io/account/${agent.pubkey}?cluster=devnet`,
      api: `/api/v1/agents/${key}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// Public reputation lookup — the core product endpoint
// Returns on-chain reputation, tier, confidence, vetting checks and a pay/don't-pay recommendation
app.get("/reputation/:address", async (req, res) => {
  try {
    const key = req.params.address;
    // Validate it looks like a base58 pubkey
    try { new PublicKey(key); } catch { return res.status(400).json({ error: "invalid Solana address" }); }

    const profiles = await listSellerProfiles(sellerAuthority);
    const agent = profiles.find((a: any) => a.pubkey === key || a.authority === key);
    if (!agent) return res.status(404).json({ error: "agent not found", address: key });

    const total = agent.completedCount + agent.failedCount;
    const successRate = total > 0 ? Number(((agent.completedCount / total) * 100).toFixed(1)) : 0;
    const ageDays = (Math.floor(Date.now() / 1000) - agent.lastUpdated) / 86400;

    res.json({
      address: key,
      reputation: {
        score: agent.reputationScore,
        completedCount: agent.completedCount,
        failedCount: agent.failedCount,
        successRate,
        totalVolume: agent.totalVolume,
        distinctBuyers: agent.distinctBuyers,
        lastUpdated: agent.lastUpdated,
        lastUpdatedDaysAgo: Math.floor(ageDays),
      },
      tier: agent.completedCount >= 15 && agent.reputationScore >= 90 ? "Elite"
          : agent.completedCount >= 5 && agent.reputationScore >= 70 ? "Trusted" : "New",
      recommendation: agent.reputationScore >= 80 && successRate >= 80 ? "proceed" : "caution",
      evidence: `https://solscan.io/account/${agent.pubkey}?cluster=devnet`,
      api: `/api/v1/agents/${key}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// Public reputation lookup — the core product endpoint
// Returns on-chain reputation, tier, confidence, vetting checks and a pay/don't-pay recommendation
app.get("/reputation/:address", async (req, res) => {
  try {
    const key = req.params.address;
    // Validate it looks like a base58 pubkey
    try { new PublicKey(key); } catch { return res.status(400).json({ error: "invalid Solana address" }); }

    const profiles = await listSellerProfiles(sellerAuthority);
    const agent = profiles.find((a: any) => a.pubkey === key || a.authority === key);
    if (!agent) return res.status(404).json({ error: "agent not found", address: key });

    const total = agent.completedCount + agent.failedCount;
    const successRate = total > 0 ? Number(((agent.completedCount / total) * 100).toFixed(1)) : 0;
    const ageDays = (Math.floor(Date.now() / 1000) - agent.lastUpdated) / 86400;

    res.json({
      address: key,
      reputation: {
        score: agent.reputationScore,
        completedCount: agent.completedCount,
        failedCount: agent.failedCount,
        successRate,
        totalVolume: agent.totalVolume,
        distinctBuyers: agent.distinctBuyers,
        lastUpdated: agent.lastUpdated,
        lastUpdatedDaysAgo: Math.floor(ageDays),
      },
      tier: agent.completedCount >= 15 && agent.reputationScore >= 90 ? "Elite"
          : agent.completedCount >= 5 && agent.reputationScore >= 70 ? "Trusted" : "New",
      recommendation: agent.reputationScore >= 80 && successRate >= 80 ? "proceed" : "caution",
      evidence: `https://solscan.io/account/${agent.pubkey}?cluster=devnet`,
      api: `/api/v1/agents/${key}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ---- Buyer attestations ----
// Buyers submit quality evaluations after each purchase. Stored in-memory for
// now; the roadmap has these going on-chain as a separate instruction.
interface Attestation {
  paymentSignature: string;
  sellerAddress: string;
  qualityScore: number;
  checks: { id: string; label: string; pass: boolean; detail: string }[];
  latencyMs: number;
  task: string;
  timestamp: string;
  receivedAt: string;
}
const attestations: Attestation[] = [];

app.post("/attest", express.json(), (req, res) => {
  const { paymentSignature, sellerAddress, qualityScore, checks, latencyMs, task, timestamp } = req.body ?? {};

  if (!paymentSignature || !sellerAddress || qualityScore === undefined) {
    return res.status(400).json({ error: "missing required fields: paymentSignature, sellerAddress, qualityScore" });
  }

  // Dedupe — one attestation per payment
  if (attestations.some(a => a.paymentSignature === paymentSignature)) {
    return res.status(409).json({ error: "attestation already recorded for this payment" });
  }

  const attestation: Attestation = {
    paymentSignature,
    sellerAddress,
    qualityScore: Number(qualityScore),
    checks: Array.isArray(checks) ? checks : [],
    latencyMs: Number(latencyMs) || 0,
    task: String(task || "unknown"),
    timestamp: timestamp || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };

  attestations.unshift(attestation);
  if (attestations.length > 200) attestations.length = 200;

  logEvent("buyer_attestation", `Quality ${attestation.qualityScore}/100 for "${attestation.task}" (${attestation.checks.filter(c => c.pass).length}/${attestation.checks.length} checks passed, ${attestation.latencyMs}ms)`, paymentSignature);

  res.json({
    accepted: true,
    qualityScore: attestation.qualityScore,
    message: "Attestation recorded — this is the data the chain alone doesn't have",
  });
});

// Public: view attestations for a seller
app.get("/attestations/:address", (req, res) => {
  const addr = req.params.address;
  const forSeller = attestations.filter(a => a.sellerAddress === addr);
  const avgScore = forSeller.length > 0
    ? Math.round(forSeller.reduce((s, a) => s + a.qualityScore, 0) / forSeller.length)
    : null;
  res.json({
    address: addr,
    count: forSeller.length,
    averageQuality: avgScore,
    attestations: forSeller.slice(0, 50),
  });
});

// Public: all recent attestations (for the frontend feed)
app.get("/attestations", (_req, res) => {
  res.json(attestations.slice(0, 50));
});

app.use("/api/v1", createApiV1Router({
  connection,
  programId: PROGRAM_ID,
  idl,
  usdcMint: USDC_MINT,
  listAgents: async () => {
    const profiles = await listSellerProfiles(sellerAuthority);
    return profiles.sort((a: any, b: any) => b.reputationScore - a.reputationScore);
  },
  logEvent,
}));

app.listen(PORT, () => {
  console.log(`Seller agent listening on http://localhost:${PORT}`);
  console.log(`Seller wallet: ${sellerAuthority.publicKey.toBase58()}`);
  console.log(`Seller token account: ${sellerTokenAccount}`);
});
