import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Connection, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PORT, RPC_URL, USDC_MINT, SERVICE_PRICE } from "./config.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import { loadKeypair, recordFailure, listSellerProfiles, ensureSellerProfile, getProtocolConfig, } from "./anchorClient.js";
import { performService, isSupportedTask, SUPPORTED_TASKS } from "./service.js";
import { createApiV1Router } from "./api-v1.js";
import idl from "./idl/agent_economy.json" with { type: "json" };
const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");
const app = express();
const ALLOWED_ORIGINS = [
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
const sellerAuthority = loadKeypair("SELLER_KEYPAIR_SECRET", process.env.SELLER_KEYPAIR_PATH ?? "./seller-keypair.json");
const connection = new Connection(RPC_URL, "confirmed");
const sellerTokenAccount = (await getOrCreateAssociatedTokenAccount(connection, sellerAuthority, USDC_MINT, sellerAuthority.publicKey)).address.toBase58();
const profileState = await ensureSellerProfile(sellerAuthority, SERVICE_PRICE);
if (profileState !== "exists") {
    console.warn(`SellerProfile ${profileState === "migrated" ? "MIGRATED to new layout — counters reset to zero" : "created fresh"}`);
}
const protocolConfig = await getProtocolConfig(sellerAuthority);
const protocolFeeBps = protocolConfig?.protocolFeeBps ?? 0;
console.log(`Protocol fee: ${protocolFeeBps} bps${protocolConfig ? "" : " (ProtocolConfig not initialized)"}`);
const seenSignatures = new Set();
const events = [];
let eventId = 0;
function logEvent(step, message, signature) {
    events.unshift({ id: eventId++, timestamp: new Date().toISOString(), step, message, signature });
    if (events.length > 30)
        events.length = 30;
    console.log(`[${step}] ${message}`);
}
app.get("/events", (_req, res) => {
    res.json(events);
});
app.post("/service", serviceLimiter, async (req, res) => {
    const { paymentSignature, task: requestedTask, params } = req.body ?? {};
    const task = requestedTask ?? "network-report";
    if (!isSupportedTask(task)) {
        logEvent("receive_request", `Rejected unknown task "${String(task).slice(0, 40)}"`);
        return res.status(400).json({ error: "unsupported task", supportedTasks: SUPPORTED_TASKS });
    }
    if (!paymentSignature) {
        logEvent("receive_request", "Buyer requested service, no payment attached");
        logEvent("402_challenge", `Sent 402 — price ${buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps).amount} base units`);
        return res.status(402).json({
            error: "payment required",
            paymentRequirements: buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps),
        });
    }
    logEvent("verify_payment", `Verifying signature ${paymentSignature.slice(0, 12)}...`, paymentSignature);
    if (seenSignatures.has(paymentSignature)) {
        logEvent("verify_payment", "Rejected — signature already used", paymentSignature);
        return res.status(409).json({ error: "payment signature already used" });
    }
    const result = await verifyPayment(paymentSignature, sellerTokenAccount);
    if (!result.ok) {
        logEvent("verify_payment", `Failed — ${result.reason}`, paymentSignature);
        try {
            await recordFailure(sellerAuthority);
            logEvent("reputation_update", "Recorded failure on-chain (seller self-reported)");
        }
        catch (err) {
            console.error("record_failure failed:", err);
            logEvent("reputation_update", "Failed to record failure on-chain");
        }
        return res.status(402).json({
            error: "payment verification failed",
            reason: result.reason,
            paymentRequirements: buildPaymentRequirements(sellerTokenAccount, sellerAuthority.publicKey.toBase58(), protocolFeeBps),
        });
    }
    logEvent("verify_payment", `Verified — ${result.amountPaid} base units received`, paymentSignature);
    seenSignatures.add(paymentSignature);
    let output;
    try {
        output = await performService(connection, task, params);
    }
    catch (err) {
        console.error("service execution failed:", err);
        logEvent("deliver_result", `Failed to perform task "${task}" after verified payment`);
        try {
            await recordFailure(sellerAuthority);
            logEvent("reputation_update", "Recorded failure on-chain (seller self-reported)");
        }
        catch (recordErr) {
            console.error("record_failure failed:", recordErr);
            logEvent("reputation_update", "Failed to record failure on-chain");
        }
        return res.status(500).json({ error: "service execution failed" });
    }
    const deliverMsg = task === "price-oracle"
        ? `Delivered "${task}" (${output.data.pair} $${output.data.price}, slot ${output.data.slot}) — buyer will record reputation on-chain`
        : `Delivered "${task}" (slot ${output.data.slot}, avg ${output.data.avgTps} TPS) — buyer will record reputation on-chain`;
    logEvent("deliver_result", deliverMsg, paymentSignature);
    return res.status(200).json({
        task,
        result: output.summary,
        data: output.data,
        generatedAt: output.data.generatedAt,
        sellerAuthority: sellerAuthority.publicKey.toBase58(),
        amountPaid: result.amountPaid,
    });
});
// Free preview — lets the homepage show a live price ticker without paying.
const previewLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.get("/preview/price", previewLimiter, async (_req, res) => {
    try {
        const output = await performService(connection, "price-oracle", {});
        res.json({ task: "price-oracle", result: output.summary, data: output.data, preview: true });
    }
    catch (err) {
        console.error("price preview failed:", err);
        res.status(500).json({ error: "price preview unavailable" });
    }
});
app.get("/agents", async (_req, res) => {
    try {
        const profiles = await listSellerProfiles(sellerAuthority);
        profiles.sort((a, b) => b.reputationScore - a.reputationScore);
        res.json(profiles);
    }
    catch (err) {
        console.error("failed to list seller profiles:", err);
        res.status(500).json({ error: "could not load agent stats" });
    }
});
app.use("/api/v1", createApiV1Router({
    connection,
    programId: PROGRAM_ID,
    idl,
    usdcMint: USDC_MINT,
    listAgents: async () => {
        const profiles = await listSellerProfiles(sellerAuthority);
        return profiles.sort((a, b) => b.reputationScore - a.reputationScore);
    },
    logEvent,
}));
app.listen(PORT, () => {
    console.log(`Seller agent listening on http://localhost:${PORT}`);
    console.log(`Seller wallet: ${sellerAuthority.publicKey.toBase58()}`);
    console.log(`Seller token account: ${sellerTokenAccount}`);
});
