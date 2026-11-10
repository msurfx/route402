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
// ---- Client ----
export class Routex402 {
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? "https://route402-seller.onrender.com").replace(/\/$/, "");
        this.timeout = opts.timeout ?? 10000;
    }
    async fetch(path) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                signal: controller.signal,
                headers: { "Accept": "application/json" },
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Routex402Error(body.error ?? `HTTP ${res.status}`, res.status);
            }
            return (await res.json());
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * Check a seller's on-chain reputation before paying.
     * Returns score, tier, success rate, and a proceed/caution recommendation.
     *
     * @param address - Solana pubkey or authority address of the seller
     */
    async checkReputation(address) {
        return this.fetch(`/reputation/${address}`);
    }
    /**
     * Get detailed vetting report for a seller, including all checks
     * and a pay/don't-pay decision under a given policy.
     *
     * @param address - Solana pubkey or authority of the seller
     * @param policy - "standard" (default), "strict", or "off"
     */
    async getAgentDetail(address, policy = "standard") {
        return this.fetch(`/api/v1/agents/${address}?policy=${policy}`);
    }
    /**
     * List all registered agents, with optional filters.
     */
    async listAgents(opts) {
        const params = new URLSearchParams();
        if (opts?.limit)
            params.set("limit", String(opts.limit));
        if (opts?.offset)
            params.set("offset", String(opts.offset));
        if (opts?.minScore)
            params.set("minScore", String(opts.minScore));
        if (opts?.tier)
            params.set("tier", opts.tier);
        if (opts?.confidence)
            params.set("confidence", opts.confidence);
        const qs = params.toString();
        return this.fetch(`/api/v1/agents${qs ? "?" + qs : ""}`);
    }
    /**
     * Get network-wide stats: total agents, payments, volume, tier distribution.
     */
    async getStats() {
        return this.fetch(`/api/v1/stats`);
    }
    /**
     * Convenience: returns true if the seller meets the minimum threshold.
     *
     * @param address - Seller address
     * @param minScore - Minimum reputation score (default 80)
     * @param minCompleted - Minimum completed payments (default 5)
     */
    async isTrusted(address, minScore = 80, minCompleted = 5) {
        try {
            const rep = await this.checkReputation(address);
            return (rep.reputation.score >= minScore &&
                rep.reputation.completedCount >= minCompleted &&
                rep.recommendation === "proceed");
        }
        catch {
            return false;
        }
    }
}
// ---- Error ----
export class Routex402Error extends Error {
    constructor(message, status) {
        super(message);
        this.name = "Routex402Error";
        this.status = status;
    }
}
// Default export for convenience
export default Routex402;
