/**
 * Aomi integration: records agents created through the Aomi chat widget on
 * the Routex402 home page, and the on-chain actions those agents perform.
 *
 * Mounted under /api/v1/aomi. Nothing here signs or moves funds. Every action
 * is verified against the chain before it is logged: the transaction must be
 * confirmed, must have succeeded, and must include the reporting wallet.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { PublicKey } from "@solana/web3.js";
const MAX_SIGNATURE = 100;
export function createAomiStore() {
    return { sessions: new Map(), actions: [], seen: new Set() };
}
export function shortKey(k) {
    return k.length > 12 ? `${k.slice(0, 4)}...${k.slice(-4)}` : k;
}
export function parsePubkey(value) {
    if (typeof value !== "string" || value.length < 32 || value.length > 44)
        return null;
    try {
        return new PublicKey(value);
    }
    catch {
        return null;
    }
}
export function parseCluster(value, allowed) {
    const c = typeof value === "string" && value ? value : "solana:devnet";
    return allowed.includes(c) ? c : null;
}
/** True when `wallet` is one of the transaction's account keys (static or looked up). */
export function walletInTransaction(tx, wallet) {
    const message = tx.transaction.message;
    const keys = [];
    if (typeof message.getAccountKeys === "function") {
        try {
            const resolved = message.getAccountKeys({
                accountKeysFromLookups: tx.meta?.loadedAddresses,
            });
            for (const k of resolved.keySegments().flat())
                keys.push(k.toBase58());
        }
        catch {
            // Fall through to static keys.
        }
    }
    if (!keys.length) {
        for (const k of message.staticAccountKeys ?? message.accountKeys ?? []) {
            keys.push(typeof k === "string" ? k : k.toBase58());
        }
        for (const k of tx.meta?.loadedAddresses?.writable ?? [])
            keys.push(k.toBase58());
        for (const k of tx.meta?.loadedAddresses?.readonly ?? [])
            keys.push(k.toBase58());
    }
    return keys.includes(wallet);
}
export function createAomiRouter(store, opts) {
    const r = Router();
    const maxActions = opts.maxActions ?? 200;
    const allowed = Object.keys(opts.clusters);
    const writeLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
    function touchSession(wallet) {
        const now = new Date().toISOString();
        const existing = store.sessions.get(wallet);
        if (existing) {
            existing.lastSeen = now;
            return { session: existing, isNew: false };
        }
        const session = { wallet, firstSeen: now, lastSeen: now, actions: 0 };
        store.sessions.set(wallet, session);
        return { session, isNew: true };
    }
    /**
     * GET /api/v1/aomi/activity?wallet=
     * Totals plus the most recent actions; with `wallet`, that wallet's session.
     */
    r.get("/activity", (req, res) => {
        const wallet = typeof req.query.wallet === "string" ? req.query.wallet : "";
        const session = wallet ? store.sessions.get(wallet) ?? null : null;
        const recent = (wallet ? store.actions.filter((a) => a.wallet === wallet) : store.actions).slice(0, 20);
        res.json({
            agents: store.sessions.size,
            actions: store.actions.length,
            clusters: allowed,
            session,
            recent,
            generatedAt: new Date().toISOString(),
        });
    });
    /**
     * POST /api/v1/aomi/sessions
     * Body: { wallet } — a visitor signed in to the Aomi widget with this Solana wallet.
     */
    r.post("/sessions", writeLimiter, (req, res) => {
        const pk = parsePubkey(req.body?.wallet);
        if (!pk)
            return res.status(400).json({ error: "wallet must be a base58 Solana public key" });
        const wallet = pk.toBase58();
        const { session, isNew } = touchSession(wallet);
        if (isNew)
            opts.logEvent("aomi_session", `New Aomi agent signed in (${shortKey(wallet)})`);
        res.status(isNew ? 201 : 200).json({ session, isNew });
    });
    /**
     * POST /api/v1/aomi/actions
     * Body: { wallet, signature, cluster? } — the agent completed an on-chain action.
     * The transaction is fetched from the named cluster and must be confirmed,
     * successful, and include `wallet`; otherwise nothing is recorded.
     */
    r.post("/actions", writeLimiter, async (req, res) => {
        const pk = parsePubkey(req.body?.wallet);
        if (!pk)
            return res.status(400).json({ error: "wallet must be a base58 Solana public key" });
        const signature = req.body?.signature;
        if (typeof signature !== "string" || signature.length < 64 || signature.length > MAX_SIGNATURE || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) {
            return res.status(400).json({ error: "signature must be a base58 transaction signature" });
        }
        const cluster = parseCluster(req.body?.cluster, allowed);
        if (!cluster)
            return res.status(400).json({ error: "unsupported cluster", supported: allowed });
        const wallet = pk.toBase58();
        const key = `${cluster}:${signature}`;
        if (store.seen.has(key)) {
            const existing = store.actions.find((a) => a.signature === signature && a.cluster === cluster);
            return res.status(200).json({ action: existing, duplicate: true });
        }
        const connection = opts.clusters[cluster];
        let tx;
        try {
            tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        }
        catch (err) {
            return res.status(502).json({ error: `rpc lookup failed: ${err?.message ?? String(err)}` });
        }
        if (!tx)
            return res.status(404).json({ error: "transaction not found on " + cluster });
        if (tx.meta?.err)
            return res.status(422).json({ error: "transaction failed on-chain; not recorded" });
        if (!walletInTransaction(tx, wallet))
            return res.status(422).json({ error: "wallet is not a party to this transaction" });
        const action = {
            wallet,
            signature,
            cluster,
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
            verifiedAt: new Date().toISOString(),
        };
        store.seen.add(key);
        store.actions.unshift(action);
        if (store.actions.length > maxActions)
            store.actions.length = maxActions;
        const { session, isNew } = touchSession(wallet);
        session.actions += 1;
        if (isNew)
            opts.logEvent("aomi_session", `New Aomi agent signed in (${shortKey(wallet)})`);
        opts.logEvent("aomi_action", `Aomi agent completed an on-chain action (${shortKey(wallet)})`, cluster === "solana:devnet" ? signature : undefined);
        res.status(201).json({ action, session });
    });
    return r;
}
