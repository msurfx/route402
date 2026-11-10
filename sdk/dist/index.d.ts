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
export declare class Routex402 {
    private baseUrl;
    private timeout;
    constructor(opts?: Routex402Options);
    private fetch;
    /**
     * Check a seller's on-chain reputation before paying.
     * Returns score, tier, success rate, and a proceed/caution recommendation.
     *
     * @param address - Solana pubkey or authority address of the seller
     */
    checkReputation(address: string): Promise<ReputationResult>;
    /**
     * Get detailed vetting report for a seller, including all checks
     * and a pay/don't-pay decision under a given policy.
     *
     * @param address - Solana pubkey or authority of the seller
     * @param policy - "standard" (default), "strict", or "off"
     */
    getAgentDetail(address: string, policy?: "standard" | "strict" | "off"): Promise<DetailedAgentResult>;
    /**
     * List all registered agents, with optional filters.
     */
    listAgents(opts?: {
        limit?: number;
        offset?: number;
        minScore?: number;
        tier?: string;
        confidence?: string;
    }): Promise<AgentListResult>;
    /**
     * Get network-wide stats: total agents, payments, volume, tier distribution.
     */
    getStats(): Promise<NetworkStats>;
    /**
     * Convenience: returns true if the seller meets the minimum threshold.
     *
     * @param address - Seller address
     * @param minScore - Minimum reputation score (default 80)
     * @param minCompleted - Minimum completed payments (default 5)
     */
    isTrusted(address: string, minScore?: number, minCompleted?: number): Promise<boolean>;
}
export declare class Routex402Error extends Error {
    status: number;
    constructor(message: string, status: number);
}
export default Routex402;
