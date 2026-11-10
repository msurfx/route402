import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Routex402 agent services — each task is a real paid agent that pulls live
 * Solana devnet data. Zero external API dependencies, zero per-call cost.
 *
 * Tasks:
 *  - network-report   Original TPS/epoch report
 *  - price-oracle     Synthetic SOL/USDC price derived from TPS
 *  - uptime-monitor   RPC latency & health check
 *  - whale-watcher    Largest recent accounts by lamport balance
 *  - validator-score   Random validator stats & performance
 */

export const SUPPORTED_TASKS = [
  "network-report",
  "price-oracle",
  "uptime-monitor",
  "whale-watcher",
  "validator-score",
] as const;
export type Task = (typeof SUPPORTED_TASKS)[number];

export interface ServiceParams {
  sampleCount?: number;
  pair?: string;
}

export interface NetworkReport {
  cluster: string;
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgressPct: number;
  samples: number;
  avgTps: number;
  peakTps: number;
  generatedAt: string;
}

export function isSupportedTask(task: string): task is Task {
  return (SUPPORTED_TASKS as readonly string[]).includes(task);
}

export async function performService(
  connection: Connection,
  task: Task,
  params: ServiceParams = {}
): Promise<{ summary: string; data: any }> {
  switch (task) {
    case "network-report":
      return networkReport(connection, params);
    case "price-oracle":
      return priceOracle(connection, params);
    case "uptime-monitor":
      return uptimeMonitor(connection);
    case "whale-watcher":
      return whaleWatcher(connection);
    case "validator-score":
      return validatorScore(connection);
  }
}

/* ---------- network-report ---------- */

async function networkReport(
  connection: Connection,
  params: ServiceParams
): Promise<{ summary: string; data: NetworkReport }> {
  const sampleCount = Math.min(Math.max(Math.trunc(params.sampleCount ?? 5), 1), 10);

  const [slot, blockHeight, epochInfo, samples] = await Promise.all([
    connection.getSlot(),
    connection.getBlockHeight(),
    connection.getEpochInfo(),
    connection.getRecentPerformanceSamples(sampleCount),
  ]);

  const tpsValues = samples
    .filter((s) => s.samplePeriodSecs > 0)
    .map((s) => s.numTransactions / s.samplePeriodSecs);
  const avgTps =
    tpsValues.length > 0
      ? tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length
      : 0;
  const peakTps = tpsValues.length > 0 ? Math.max(...tpsValues) : 0;

  const epochProgressPct = (epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100;

  const data: NetworkReport = {
    cluster: "devnet",
    slot,
    blockHeight,
    epoch: epochInfo.epoch,
    epochProgressPct: Number(epochProgressPct.toFixed(2)),
    samples: tpsValues.length,
    avgTps: Number(avgTps.toFixed(1)),
    peakTps: Number(peakTps.toFixed(1)),
    generatedAt: new Date().toISOString(),
  };

  const summary =
    `Devnet network report: slot ${slot}, epoch ${data.epoch} ` +
    `(${data.epochProgressPct}% complete), avg ${data.avgTps} TPS ` +
    `(peak ${data.peakTps}) over the last ${data.samples} minute(s).`;

  return { summary, data };
}

/* ---------- price-oracle (enhanced) ---------- */

interface PriceReport {
  pair: string;
  price: number;
  change24h: number;
  slot: number;
  epoch: number;
  blockTime: number;
  networkHealth: "healthy" | "degraded" | "slow";
  avgTps: number;
  txVolume: number;
  source: string;
  generatedAt: string;
}

// Simple in-memory price history for 24h change calculation
const priceHistory: { price: number; time: number }[] = [];

async function priceOracle(
  connection: Connection,
  params: ServiceParams
): Promise<{ summary: string; data: PriceReport }> {
  const pair = (params.pair ?? "SOL/USDC").toUpperCase();

  const [slot, epochInfo, samples] = await Promise.all([
    connection.getSlot(),
    connection.getEpochInfo(),
    connection.getRecentPerformanceSamples(5),
  ]);

  const tpsValues = samples
    .filter((s: any) => s.samplePeriodSecs > 0)
    .map((s: any) => s.numTransactions / s.samplePeriodSecs);
  const avgTps = tpsValues.length > 0
    ? tpsValues.reduce((sum: number, v: number) => sum + v, 0) / tpsValues.length
    : 2000;

  // Map TPS range (500-5000) to price range (120-180)
  const normalized = Math.max(0, Math.min(1, (avgTps - 500) / 4500));
  const price = Number((120 + normalized * 60).toFixed(2));

  // Track price history for change calculation
  const now = Date.now();
  priceHistory.push({ price, time: now });
  // Keep only last 24h of data points
  while (priceHistory.length > 0 && now - priceHistory[0].time > 86400000) {
    priceHistory.shift();
  }
  const oldestPrice = priceHistory.length > 1 ? priceHistory[0].price : price;
  const change24h = oldestPrice > 0 ? Number(((price - oldestPrice) / oldestPrice * 100).toFixed(2)) : 0;

  // Network health based on TPS
  const networkHealth: PriceReport["networkHealth"] =
    avgTps >= 2000 ? "healthy" : avgTps >= 800 ? "degraded" : "slow";

  // Total tx volume from samples
  const txVolume = samples.reduce((sum: number, s: any) => sum + (s.numTransactions || 0), 0);

  // Block time estimate from samples
  const blockTime = tpsValues.length > 0 ? Number((1000 / avgTps).toFixed(1)) : 0;

  const data: PriceReport = {
    pair,
    price,
    change24h,
    slot,
    epoch: epochInfo.epoch,
    blockTime,
    networkHealth,
    avgTps: Number(avgTps.toFixed(0)),
    txVolume,
    source: "solana-devnet-tps-derived",
    generatedAt: new Date().toISOString(),
  };

  const healthEmoji = networkHealth === "healthy" ? "🟢" : networkHealth === "degraded" ? "🟡" : "🔴";
  const changeStr = change24h >= 0 ? `+${change24h}%` : `${change24h}%`;
  const summary = `${pair} $${price} (${changeStr}) | TPS ${data.avgTps} ${healthEmoji} ${networkHealth} | slot ${slot} epoch ${data.epoch}`;

  return { summary, data };
}

/* ---------- uptime-monitor ---------- */

interface UptimeReport {
  cluster: string;
  rpcLatencyMs: number;
  slot: number;
  blockHeight: number;
  epoch: number;
  epochProgressPct: number;
  slotsBehind: number;
  status: "operational" | "degraded" | "down";
  avgTps: number;
  generatedAt: string;
}

async function uptimeMonitor(
  connection: Connection
): Promise<{ summary: string; data: UptimeReport }> {
  const start = Date.now();

  const [slot, blockHeight, epochInfo, samples] = await Promise.all([
    connection.getSlot(),
    connection.getBlockHeight(),
    connection.getEpochInfo(),
    connection.getRecentPerformanceSamples(3),
  ]);

  const rpcLatencyMs = Date.now() - start;

  const tpsValues = samples
    .filter((s: any) => s.samplePeriodSecs > 0)
    .map((s: any) => s.numTransactions / s.samplePeriodSecs);
  const avgTps = tpsValues.length > 0
    ? tpsValues.reduce((sum: number, v: number) => sum + v, 0) / tpsValues.length
    : 0;

  const slotsBehind = slot - blockHeight;
  const epochProgressPct = Number(((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2));

  const status: UptimeReport["status"] =
    rpcLatencyMs < 2000 && avgTps > 500 ? "operational" :
    rpcLatencyMs < 5000 ? "degraded" : "down";

  const data: UptimeReport = {
    cluster: "devnet",
    rpcLatencyMs,
    slot,
    blockHeight,
    epoch: epochInfo.epoch,
    epochProgressPct,
    slotsBehind,
    status,
    avgTps: Number(avgTps.toFixed(1)),
    generatedAt: new Date().toISOString(),
  };

  const statusIcon = status === "operational" ? "✅" : status === "degraded" ? "⚠️" : "❌";
  const summary = `${statusIcon} Devnet ${status} — RPC ${rpcLatencyMs}ms, ${data.avgTps} TPS, slot ${slot}, ${slotsBehind} slots behind tip`;

  return { summary, data };
}

/* ---------- whale-watcher ---------- */

interface WhaleReport {
  cluster: string;
  slot: number;
  epoch: number;
  topAccounts: {
    address: string;
    balanceSol: number;
    rank: number;
  }[];
  totalScanned: number;
  generatedAt: string;
}

async function whaleWatcher(
  connection: Connection
): Promise<{ summary: string; data: WhaleReport }> {
  const [slot, epochInfo, largestAccounts] = await Promise.all([
    connection.getSlot(),
    connection.getEpochInfo(),
    connection.getLargestAccounts({ commitment: "finalized" }),
  ]);

  const topAccounts = largestAccounts.value
    .slice(0, 10)
    .map((acct, i) => ({
      address: acct.address.toBase58(),
      balanceSol: Number((acct.lamports / 1e9).toFixed(4)),
      rank: i + 1,
    }));

  const totalSol = topAccounts.reduce((s, a) => s + a.balanceSol, 0);

  const data: WhaleReport = {
    cluster: "devnet",
    slot,
    epoch: epochInfo.epoch,
    topAccounts,
    totalScanned: largestAccounts.value.length,
    generatedAt: new Date().toISOString(),
  };

  const summary = `🐋 Top ${topAccounts.length} devnet accounts hold ${totalSol.toLocaleString()} SOL | slot ${slot} epoch ${data.epoch}`;

  return { summary, data };
}

/* ---------- validator-score ---------- */

interface ValidatorReport {
  cluster: string;
  slot: number;
  epoch: number;
  totalValidators: number;
  activeValidators: number;
  topValidators: {
    address: string;
    activatedStakeSol: number;
    commission: number;
    lastVote: number;
    epochCredits: number;
    rank: number;
  }[];
  networkStakeSol: number;
  generatedAt: string;
}

async function validatorScore(
  connection: Connection
): Promise<{ summary: string; data: ValidatorReport }> {
  const [slot, epochInfo, voteAccounts] = await Promise.all([
    connection.getSlot(),
    connection.getEpochInfo(),
    connection.getVoteAccounts(),
  ]);

  const allValidators = [
    ...voteAccounts.current.map((v) => ({ ...v, active: true })),
    ...voteAccounts.delinquent.map((v) => ({ ...v, active: false })),
  ];

  // Sort by activated stake descending
  allValidators.sort((a, b) => b.activatedStake - a.activatedStake);

  const topValidators = allValidators.slice(0, 10).map((v, i) => {
    const lastCredits = v.epochCredits.length > 0
      ? v.epochCredits[v.epochCredits.length - 1]
      : [0, 0, 0];
    return {
      address: v.votePubkey,
      activatedStakeSol: Number((v.activatedStake / 1e9).toFixed(2)),
      commission: v.commission,
      lastVote: v.lastVote,
      epochCredits: Number(lastCredits[1]) - Number(lastCredits[2]),
      rank: i + 1,
    };
  });

  const networkStakeSol = Number(
    (allValidators.reduce((s, v) => s + v.activatedStake, 0) / 1e9).toFixed(2)
  );

  const data: ValidatorReport = {
    cluster: "devnet",
    slot,
    epoch: epochInfo.epoch,
    totalValidators: allValidators.length,
    activeValidators: voteAccounts.current.length,
    topValidators,
    networkStakeSol,
    generatedAt: new Date().toISOString(),
  };

  const summary = `🏛️ ${voteAccounts.current.length}/${allValidators.length} validators active | ${networkStakeSol.toLocaleString()} SOL staked | slot ${slot} epoch ${data.epoch}`;

  return { summary, data };
}
