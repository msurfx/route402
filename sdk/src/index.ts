/**
 * Routex402 SDK
 *
 * On-chain reputation layer for AI agent payments on Solana.
 * Check any seller's trust score before paying, and attest after delivery.
 *
 * Usage:
 *   import { Routex402 } from "routex402";
 *   const r = new Routex402();                       // devnet default
 *   const rep = await r.checkReputation("ADDRESS");  // check before paying
 *   if (rep.recommendation === "proceed") { ... }
 */

// ---- Types ----

export interface ReputationData {
  score: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  totalVolume: number;
  distinctBuyers: number;
  lastUpdated: number;
  lastUpdatedDaysAgo: number;
}

export interface ReputationResult {
  address: string;
  reputation: ReputationData;
  tier: "Elite" | "Trusted" | "New";
  recommendation: "proceed" | "caution";
  evidence: string;
}

export interface AgentProfile {
  pubkey: string;
  authority: string;
  price: number;
  reputationScore: number;
  completedCount: number;
  failedCount: number;
  totalVolume: number;
  distinctBuyers: number;
  lastUpdated: number;
  tier: string;
  confidence: string;
}

export interface AgentListResult {
  total: number;
  limit: number;
  offset: number;
  agents: AgentProfile[];
  nextOffset: number | null;
}

export interface VettingCheck {
  id: string;
  label: string;
  status: "pass" | "caution" | "fail" | "unknown";
  detail: string;
}

export interface DetailedAgentResult {
  agent: AgentProfile;
  tier: string;
  confidence: string;
  checks: VettingCheck[];
  decision: {
    recommendation: "proceed" | "do_not_pay";
    blockReasons: string[];
    policy: string;
  };
  evidence: string;
}

export interface NetworkStats {
  agents: number;
  totalPayments: number;
  totalVolume: number;
  averageReputation: number;
  flaggedAgents: number;
  activeLast30d: number;
  confidenceDistribution: Record<string, number>;
  tierDistribution: Record<string, number>;
  generatedAt: string;
}

export interface Routex402Options {
  /** Base URL of the Routex402 seller service. Defaults to production. */
  baseUrl?: string;
  /** Request timeout in ms. Default 10000. */
  timeout?: number;
}

// ---- Client ----

export class Routex402 {
  private baseUrl: string;
  private timeout: number;

  constructor(opts: Routex402Options = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://route402-seller.onrender.com").replace(/\/$/, "");
    this.timeout = opts.timeout ?? 10_000;
  }

  private async fetch<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Routex402Error(
          (body as any).error ?? `HTTP ${res.status}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check a seller's on-chain reputation before paying.
   * Returns score, tier, success rate, and a proceed/caution recommendation.
   *
   * @param address - Solana pubkey or authority address of the seller
   */
  async checkReputation(address: string): Promise<ReputationResult> {
    return this.fetch<ReputationResult>(`/reputation/${address}`);
  }

  /**
   * Get detailed vetting report for a seller, including all checks
   * and a pay/don't-pay decision under a given policy.
   *
   * @param address - Solana pubkey or authority of the seller
   * @param policy - "standard" (default), "strict", or "off"
   */
  async getAgentDetail(
    address: string,
    policy: "standard" | "strict" | "off" = "standard",
  ): Promise<DetailedAgentResult> {
    return this.fetch<DetailedAgentResult>(
      `/api/v1/agents/${address}?policy=${policy}`,
    );
  }

  /**
   * List all registered agents, with optional filters.
   */
  async listAgents(opts?: {
    limit?: number;
    offset?: number;
    minScore?: number;
    tier?: string;
    confidence?: string;
  }): Promise<AgentListResult> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.minScore) params.set("minScore", String(opts.minScore));
    if (opts?.tier) params.set("tier", opts.tier);
    if (opts?.confidence) params.set("confidence", opts.confidence);
    const qs = params.toString();
    return this.fetch<AgentListResult>(`/api/v1/agents${qs ? "?" + qs : ""}`);
  }

  /**
   * Get network-wide stats: total agents, payments, volume, tier distribution.
   */
  async getStats(): Promise<NetworkStats> {
    return this.fetch<NetworkStats>(`/api/v1/stats`);
  }

  /**
   * Convenience: returns true if the seller meets the minimum threshold.
   *
   * @param address - Seller address
   * @param minScore - Minimum reputation score (default 80)
   * @param minCompleted - Minimum completed payments (default 5)
   */
  async isTrusted(
    address: string,
    minScore = 80,
    minCompleted = 5,
  ): Promise<boolean> {
    try {
      const rep = await this.checkReputation(address);
      return (
        rep.reputation.score >= minScore &&
        rep.reputation.completedCount >= minCompleted &&
        rep.recommendation === "proceed"
      );
    } catch {
      return false;
    }
  }
}

// ---- Error ----

export class Routex402Error extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "Routex402Error";
    this.status = status;
  }
}

// Default export for convenience
export default Routex402;
