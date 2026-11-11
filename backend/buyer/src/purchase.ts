import fs from "node:fs";
import {
  AnchorProvider,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import idl from "./idl/agent_economy.json" with { type: "json" };
import { validateResponse, type AttestationResult } from "./validate.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";
const USDC_MINT = new PublicKey("EKFUzCYkafhGWDArX2QVr1E4cGydnyk1R6pwP9j3ztFC");
const PROGRAM_ID = new PublicKey("6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt");

function loadKeypair(envVarName: string, filePath: string): Keypair {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    const secret = JSON.parse(fromEnv);
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export interface PurchaseResult {
  success: boolean;
  message: string;
  signature?: string;
  result?: string;
  /** With pay_and_record, payment and reputation are ONE atomic transaction,
   * so this is the same signature as `signature`. Kept as a separate field so
   * existing consumers (frontend, monitoring) don't break. */
  reputationTxSignature?: string;
  /** Fee taken by the protocol, in base units — surfaced for transparency. */
  protocolFee?: number;
  /** Buyer-side quality attestation — auto-generated after each purchase. */
  attestation?: AttestationResult;
}

/**
 * Runs the full buyer flow once.
 *
 * As of the 2026-07 program upgrade, payment and reputation are no longer two
 * separate steps (raw SPL transfer, then a separate record_payment call whose
 * amount was never verified against the transfer). The buyer now calls the
 * program's pay_and_record instruction: the token transfer happens via CPI
 * inside the instruction — split between the seller and the protocol treasury
 * per the on-chain ProtocolConfig fee — and the seller's reputation is updated
 * in the same transaction, only after the transfer succeeds. One signature,
 * atomically both loops.
 */
export async function runPurchase(
  taskOverride?: string,
  agentName?: string
): Promise<PurchaseResult> {
  const task = taskOverride ?? "network-report";
  const connection = new Connection(RPC_URL, "confirmed");
  const buyer = loadKeypair(
    "BUYER_KEYPAIR_SECRET",
    process.env.BUYER_KEYPAIR_PATH ?? "./buyer-keypair.json"
  );

  const firstResponse = await fetch(`${SELLER_URL}/service`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, ...(agentName ? { agent: agentName } : {}) }),
  });

  if (firstResponse.status !== 402) {
    const body = await firstResponse.text();
    return { success: false, message: `Unexpected response (expected 402): ${body}` };
  }

  const { paymentRequirements } = await firstResponse.json();
  const sellerAuthority = new PublicKey(paymentRequirements.sellerAuthority);
  const sellerTokenAccount = new PublicKey(paymentRequirements.payTo);

  const provider = new AnchorProvider(connection, new Wallet(buyer), {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider) as any;

  // The fee rate and treasury destination live in the on-chain ProtocolConfig —
  // read them from the chain rather than trusting the seller's word for it.
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  let config;
  try {
    config = await program.account.protocolConfig.fetch(configPda);
  } catch {
    return {
      success: false,
      message:
        "ProtocolConfig not initialized on-chain — run initialize_config before purchases can settle",
    };
  }
  const feeBps = Number(config.protocolFeeBps);

  // Gross-up so the seller nets the quoted price after the program's fee
  // split. Prefer the seller's own grossAmount quote when present (newer
  // sellers include it); fall back to computing it from on-chain fee bps.
  const netPrice = Number(paymentRequirements.amount);
  const grossAmount =
    paymentRequirements.grossAmount ??
    (feeBps > 0 ? Math.ceil((netPrice * 10_000) / (10_000 - feeBps)) : netPrice);
  const protocolFee = Math.floor((grossAmount * feeBps) / 10_000);

  const buyerTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    buyer,
    USDC_MINT,
    buyer.publicKey
  );

  const [sellerProfile] = PublicKey.findProgramAddressSync(
    [Buffer.from("seller"), sellerAuthority.toBuffer()],
    PROGRAM_ID
  );
  const [buyerSellerLink] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), sellerAuthority.toBuffer(), buyer.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // One atomic transaction: transfer to seller + fee to treasury (both via
  // CPI) + reputation update. If any part fails, nothing happened.
  let signature: string;
  try {
    signature = await program.methods
      .payAndRecord(new BN(grossAmount))
      .accounts({
        buyer: buyer.publicKey,
        seller: sellerAuthority,
        sellerProfile,
        buyerSellerLink,
        config: configPda,
        mint: USDC_MINT,
        buyerTokenAccount: buyerTokenAccount.address,
        sellerTokenAccount,
        treasuryTokenAccount: config.treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  } catch (err: any) {
    return {
      success: false,
      message: `pay_and_record failed: ${err?.message ?? String(err)}`,
    };
  }

  const requestStart = Date.now();
  const secondResponse = await fetch(`${SELLER_URL}/service`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentSignature: signature, task, ...(agentName ? { agent: agentName } : {}) }),
  });

  const body = await secondResponse.json();
  const latencyMs = Date.now() - requestStart;

  if (secondResponse.status !== 200) {
    // Still attest — seller failed to deliver after payment
    const attestation = validateResponse(task, null, latencyMs);
    await submitAttestation(attestation, signature, sellerAuthority.toBase58()).catch(err => {
      console.error("attestation submit failed:", err);
    });
    return { success: false, message: `Purchase failed (${secondResponse.status})`, signature, attestation };
  }

  // Auto-attest: evaluate what we got
  const attestation = validateResponse(task, body, latencyMs);

  // Submit attestation to seller (non-blocking — don't let it break the purchase flow)
  await submitAttestation(attestation, signature, sellerAuthority.toBase58()).catch(err => {
    console.error("attestation submit failed:", err);
  });

  return {
    success: true,
    message: "Purchase complete — payment and reputation settled atomically",
    signature,
    result: body.result,
    reputationTxSignature: signature,
    protocolFee,
    attestation,
  };
}

// ---- Attestation submission ----

async function submitAttestation(
  attestation: AttestationResult,
  paymentSignature: string,
  sellerAddress: string,
): Promise<void> {
  const res = await fetch(`${SELLER_URL}/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentSignature,
      sellerAddress,
      ...attestation,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`Attest endpoint returned ${res.status}: ${err}`);
  }
}
