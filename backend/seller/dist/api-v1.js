/**
 * API v1 router for the Routex402 seller service.
 *
 * Mount with:
 *   import { createApiV1Router } from "./api-v1.js";
 *   app.use("/api/v1", createApiV1Router({ connection, programId, idl, usdcMint, listAgents }));
 *
 * All routes are read-only EXCEPT the unsigned-transaction endpoints, which
 * BUILD transactions but never sign them — the caller signs and broadcasts.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import BN from "bn.js";
import { PublicKey, Transaction, Keypair, SystemProgram, } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { createAomiRouter, createAomiStore } from "./aomi.js";
function confidence(a) {
    const { completedCount: c, distinctBuyers: b } = a;
    if (c < 5)
        return "Unrated";
    if (b === 0)
        return "Unknown";
    if (c >= 15 && b >= 5)
        return "High";
    if (c >= 5 && b >= 2)
        return "Medium";
    return "Low";
}
function tier(a) {
    if (a.completedCount >= 15 && a.reputationScore >= 90)
        return "Elite";
    if (a.completedCount >= 5 && a.reputationScore >= 70)
        return "Trusted";
    return "New";
}
function vettingChecks(a, now = Math.floor(Date.now() / 1000)) {
    const { completedCount: c, failedCount: f, distinctBuyers: b, lastUpdated, price, totalVolume } = a;
    const total = c + f;
    const rate = total === 0 ? 0 : (c / total) * 100;
    const ageDays = (now - lastUpdated) / 86400;
    const checks = [
        { id: "track-record", label: "Track record",
            status: c >= 15 ? "pass" : c >= 5 ? "caution" : "fail",
            detail: `${c} completed payments${c < 5 ? " (not enough history to rate)" : ""}` },
        { id: "success-rate", label: "Success rate",
            status: total === 0 ? "unknown" : rate >= 95 ? "pass" : rate >= 80 ? "caution" : "fail",
            detail: total === 0 ? "No payments recorded yet" : `${rate.toFixed(1)}% (${c} ok, ${f} failed)` },
    ];
    let bStatus;
    let bDetail;
    if (c > 0 && b === 0) {
        bStatus = "unknown";
        bDetail = "Distinct buyer count not recorded";
    }
    else if (b >= 5) {
        bStatus = "pass";
        bDetail = `${b} distinct buyers`;
    }
    else if (b >= 2) {
        bStatus = "caution";
        bDetail = `Only ${b} distinct buyers`;
    }
    else if (b === 1 && c >= 10) {
        bStatus = "fail";
        bDetail = `${c} payments from a single buyer`;
    }
    else {
        bStatus = "unknown";
        bDetail = "Too little history to judge";
    }
    checks.push({ id: "buyer-independence", label: "Buyer independence", status: bStatus, detail: bDetail });
    if (price === 0 || c === 0) {
        checks.push({ id: "volume", label: "Volume consistency", status: "unknown", detail: "Not enough data to compare" });
    }
    else {
        const expected = price * c;
        const drift = Math.abs(totalVolume - expected) / expected;
        checks.push({
            id: "volume", label: "Volume consistency",
            status: drift <= 0.05 ? "pass" : "caution",
            detail: `Volume within ${(drift * 100).toFixed(1)}% of price × payments`,
        });
    }
    checks.push({
        id: "recency", label: "Recent activity",
        status: ageDays <= 7 ? "pass" : ageDays <= 30 ? "caution" : "fail",
        detail: `Last update ${Math.floor(ageDays)} days ago`,
    });
    return checks;
}
function evaluate(agent, checks, policy) {
    if (policy === "off")
        return { recommendation: "proceed", blockReasons: [], policy };
    const reasons = [];
    if (agent.reputationScore < 80)
        reasons.push(`Reputation ${agent.reputationScore} < 80`);
    const buyerCheck = checks.find((c) => c.id === "buyer-independence");
    if (buyerCheck?.status === "fail")
        reasons.push(buyerCheck.detail);
    if (policy === "strict") {
        const conf = confidence(agent);
        if (conf !== "Medium" && conf !== "High")
            reasons.push(`Confidence is ${conf}; strict needs Medium or High`);
    }
    return {
        recommendation: reasons.length ? "do_not_pay" : "proceed",
        blockReasons: reasons, policy,
    };
}
export function createApiV1Router(opts) {
    const r = Router();
    const { connection, programId, idl, usdcMint, listAgents } = opts;
    // Read-only provider using an ephemeral keypair (never signs anything that lands on-chain).
    const readOnlyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
    const program = new Program(idl, provider);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    // Per-IP 60/min; enough for a dashboard, strict enough to resist abuse.
    r.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    const aomiStore = opts.aomiStore ?? createAomiStore();
    r.use("/aomi", createAomiRouter(aomiStore, {
        clusters: { "solana:devnet": connection, ...(opts.aomiClusters ?? {}) },
        logEvent: opts.logEvent ?? (() => { }),
    }));
    /** GET /api/v1/agents?limit=&offset=&minScore=&tier=&confidence= */
    r.get("/agents", async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? 50), 10)));
            const offset = Math.max(0, parseInt(String(req.query.offset ?? 0), 10));
            const minScore = req.query.minScore ? parseInt(String(req.query.minScore), 10) : undefined;
            const tierFilter = req.query.tier ? String(req.query.tier) : undefined;
            const confFilter = req.query.confidence ? String(req.query.confidence) : undefined;
            let all = await listAgents();
            all = all.filter((a) => {
                if (minScore !== undefined && a.reputationScore < minScore)
                    return false;
                if (tierFilter && tier(a).toLowerCase() !== tierFilter.toLowerCase())
                    return false;
                if (confFilter && confidence(a).toLowerCase() !== confFilter.toLowerCase())
                    return false;
                return true;
            });
            const total = all.length;
            const page = all.slice(offset, offset + limit).map((a) => ({
                ...a, tier: tier(a), confidence: confidence(a),
            }));
            res.json({
                total, limit, offset, agents: page,
                nextOffset: offset + limit < total ? offset + limit : null,
            });
        }
        catch (err) {
            res.status(500).json({ error: err?.message ?? String(err) });
        }
    });
    /** GET /api/v1/agents/:pubkey?policy=standard|strict|off */
    r.get("/agents/:pubkey", async (req, res) => {
        try {
            const key = req.params.pubkey;
            const policy = String(req.query.policy ?? "standard");
            const all = await listAgents();
            const agent = all.find((a) => a.pubkey === key || a.authority === key);
            if (!agent)
                return res.status(404).json({ error: "agent not found", seller: key });
            const checks = vettingChecks(agent);
            const decision = evaluate(agent, checks, policy);
            res.json({
                agent, tier: tier(agent), confidence: confidence(agent),
                checks, decision,
                evidence: `https://solscan.io/account/${agent.pubkey}?cluster=devnet`,
            });
        }
        catch (err) {
            res.status(500).json({ error: err?.message ?? String(err) });
        }
    });
    /** GET /api/v1/stats — network-wide aggregates. */
    r.get("/stats", async (_req, res) => {
        try {
            const all = await listAgents();
            const totalPayments = all.reduce((s, a) => s + a.completedCount, 0);
            const totalVolume = all.reduce((s, a) => s + a.totalVolume, 0);
            const avgScore = all.length ? all.reduce((s, a) => s + a.reputationScore, 0) / all.length : 0;
            const confDist = { High: 0, Medium: 0, Low: 0, Unknown: 0, Unrated: 0 };
            const tierDist = { Elite: 0, Trusted: 0, New: 0 };
            let flagged = 0, activeLast30d = 0;
            const now = Math.floor(Date.now() / 1000);
            for (const a of all) {
                confDist[confidence(a)] = (confDist[confidence(a)] ?? 0) + 1;
                tierDist[tier(a)] = (tierDist[tier(a)] ?? 0) + 1;
                const checks = vettingChecks(a, now);
                if (checks.find((c) => c.id === "buyer-independence" && c.status === "fail"))
                    flagged++;
                if ((now - a.lastUpdated) < 30 * 86400)
                    activeLast30d++;
            }
            res.json({
                agents: all.length,
                totalPayments,
                totalVolume,
                averageReputation: Math.round(avgScore * 10) / 10,
                flaggedAgents: flagged,
                activeLast30d,
                confidenceDistribution: confDist,
                tierDistribution: tierDist,
                aomiAgents: aomiStore.sessions.size,
                aomiActions: aomiStore.actions.length,
                generatedAt: new Date().toISOString(),
            });
        }
        catch (err) {
            res.status(500).json({ error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/v1/purchase/unsigned
     * Body: { buyer: string, seller: string, amount?: number }
     * Returns a base64-serialized unsigned Transaction for the buyer to sign
     * and broadcast. Never touches the seller's key.
     */
    r.post("/purchase/unsigned", async (req, res) => {
        try {
            const { buyer, seller, amount } = req.body ?? {};
            if (!buyer || !seller)
                return res.status(400).json({ error: "buyer and seller are required" });
            const buyerPk = new PublicKey(buyer);
            const sellerPk = new PublicKey(seller);
            const config = await program.account.protocolConfig.fetch(configPda);
            const feeBps = Number(config.protocolFeeBps);
            // Find seller's price from on-chain record; use provided amount if given
            const [sellerProfile] = PublicKey.findProgramAddressSync([Buffer.from("seller"), sellerPk.toBuffer()], programId);
            let netAmount;
            if (amount) {
                netAmount = Number(amount);
            }
            else {
                const sp = await program.account.sellerProfile.fetch(sellerProfile);
                netAmount = Number(sp.price);
            }
            const gross = feeBps > 0 ? Math.ceil((netAmount * 10_000) / (10_000 - feeBps)) : netAmount;
            const buyerToken = await getAssociatedTokenAddress(usdcMint, buyerPk);
            const sellerToken = await getAssociatedTokenAddress(usdcMint, sellerPk);
            const [buyerSellerLink] = PublicKey.findProgramAddressSync([Buffer.from("link"), sellerPk.toBuffer(), buyerPk.toBuffer()], programId);
            const ix = await program.methods.payAndRecord(new BN(gross)).accounts({
                buyer: buyerPk,
                seller: sellerPk,
                sellerProfile,
                buyerSellerLink,
                config: configPda,
                mint: usdcMint,
                buyerTokenAccount: buyerToken,
                sellerTokenAccount: sellerToken,
                treasuryTokenAccount: config.treasuryTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            }).instruction();
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            const tx = new Transaction({ feePayer: buyerPk, blockhash, lastValidBlockHeight }).add(ix);
            const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
            res.json({
                transaction: serialized,
                grossAmount: gross,
                netAmount,
                protocolFee: Math.floor((gross * feeBps) / 10_000),
                feeBps,
                blockhash,
                lastValidBlockHeight,
                note: "Sign and broadcast with the buyer wallet. Reputation lands atomically with payment.",
            });
        }
        catch (err) {
            res.status(400).json({ error: err?.message ?? String(err) });
        }
    });
    /**
     * POST /api/v1/registration/unsigned
     * Body: { authority: string, price: number }
     * Returns an unsigned initialize_seller transaction for the agent to sign.
     * Open registration: any wallet can register a seller profile.
     */
    r.post("/registration/unsigned", async (req, res) => {
        try {
            const { authority, price } = req.body ?? {};
            if (!authority || price === undefined)
                return res.status(400).json({ error: "authority and price are required" });
            const authorityPk = new PublicKey(authority);
            const priceN = Number(price);
            if (!Number.isFinite(priceN) || priceN <= 0)
                return res.status(400).json({ error: "price must be a positive number" });
            if (priceN < 1_000)
                return res.status(400).json({ error: "price must be at least 1000 base units (0.001 USDC)" });
            const [sellerProfile] = PublicKey.findProgramAddressSync([Buffer.from("seller"), authorityPk.toBuffer()], programId);
            const existing = await connection.getAccountInfo(sellerProfile);
            if (existing)
                return res.status(409).json({ error: "seller profile already exists", sellerProfile: sellerProfile.toBase58() });
            const ix = await program.methods.initializeSeller(new BN(priceN)).accounts({
                authority: authorityPk,
                sellerProfile,
                systemProgram: SystemProgram.programId,
            }).instruction();
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            const tx = new Transaction({ feePayer: authorityPk, blockhash, lastValidBlockHeight }).add(ix);
            const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
            res.json({
                transaction: serialized,
                sellerProfile: sellerProfile.toBase58(),
                blockhash,
                lastValidBlockHeight,
                note: "Sign with the authority wallet and broadcast. Your profile PDA is above.",
            });
        }
        catch (err) {
            res.status(400).json({ error: err?.message ?? String(err) });
        }
    });
    return r;
}
