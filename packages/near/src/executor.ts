import type { PolicyEngine, Reservation } from "@agentguard/core";
import { checkNearAccountId, isImplicitAccountId } from "./account-id.js";

/**
 * Minimal views of the near-api-js v7 types this adapter relies on (verified against
 * the published `near-api-js@7.4.0` type definitions; see docs/integrations.md).
 * Declaring them structurally lets the adapter be unit-tested without a network.
 */
export interface NearTxView {
  /** `FinalExecutionStatus`: "NotStarted" | "Started" | { Failure } | { SuccessValue }. */
  status: unknown;
  transaction_outcome: { id: string };
  /** `SignedTransactionView`: present in RPC transaction-status responses. */
  transaction?: { signer_id?: string; receiver_id?: string; actions?: unknown[] };
}

/** True if the RPC transaction view is exactly one native transfer matching the reservation. */
export function transactionMatches(tx: NearTxView, signerId: string, r: Reservation): boolean {
  const t = tx.transaction;
  if (!t || t.signer_id !== signerId || t.receiver_id !== r.recipientId || !Array.isArray(t.actions) || t.actions.length !== 1) {
    return false;
  }
  const action = t.actions[0] as { Transfer?: { deposit?: unknown } } | null;
  const deposit = action?.Transfer?.deposit;
  return (typeof deposit === "string" || typeof deposit === "bigint") && BigInt(deposit) === r.amountAtomic;
}

export interface NearClient {
  readonly signerAccountId: string;
  /** Network identifier reported by the RPC node (e.g. "testnet"). */
  getNetworkId(): Promise<string>;
  /** Sign and broadcast a native NEAR transfer; must not throw on an on-chain failure. */
  transfer(receiverId: string, amountYocto: bigint): Promise<NearTxView>;
  transactionStatus(txHash: string): Promise<NearTxView>;
}

export type NearExecutionStatus = "confirmed" | "failed" | "pending" | "unknown" | "refused";

export interface NearExecutionResult {
  status: NearExecutionStatus;
  /** Only ever taken from a network response; never generated locally. */
  transactionHash?: string;
  reservation?: Reservation;
  reasonCode?: string;
  message: string;
}

export const NEAR_NATIVE_ASSET = "NEAR";
export const NEAR_TESTNET = "near-testnet";

export function classifyStatus(status: unknown): "confirmed" | "failed" | "pending" {
  if (status && typeof status === "object") {
    if (Object.hasOwn(status, "SuccessValue")) return "confirmed";
    if (Object.hasOwn(status, "Failure")) return "failed";
  }
  return "pending";
}

function isTestnetSigner(id: string): boolean {
  return isImplicitAccountId(id) || id === "testnet" || id.endsWith(".testnet");
}

/**
 * Executes AgentGuard-authorised reservations as native NEAR transfers on testnet.
 *
 * Safety properties:
 *  - Only `near-testnet` reservations of the native `NEAR` asset are executed.
 *  - The RPC node must report network "testnet" before anything is signed.
 *  - Execution goes through `engine.beginExecution`, which rejects reservations that
 *    are not `reserved` or were authorised under a different policy version, and
 *    moves them to `submitted` atomically (no double execution).
 *  - A transaction hash is recorded only if the network returned one.
 *  - Errors/timeouts after broadcast leave the reservation `submitted` (it keeps
 *    counting toward limits) because the transfer may still have executed.
 */
export class NearTestnetExecutor {
  private readonly engine: PolicyEngine;
  private readonly client: NearClient;
  private readonly timeoutMs: number;

  constructor(options: { engine: PolicyEngine; client: NearClient; timeoutMs?: number }) {
    this.engine = options.engine;
    this.client = options.client;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async execute(reservationId: string): Promise<NearExecutionResult> {
    const refuse = (reasonCode: string, message: string, reservation?: Reservation): NearExecutionResult => ({
      status: "refused",
      reasonCode,
      message,
      ...(reservation ? { reservation } : {}),
    });

    const pre = await this.engine.getReservation(reservationId);
    if (!pre) return refuse("RESERVATION_NOT_FOUND", "no such reservation");
    if (pre.networkId !== NEAR_TESTNET) return refuse("NETWORK_NOT_SUPPORTED", `adapter only executes ${NEAR_TESTNET}`, pre);
    if (pre.assetId !== NEAR_NATIVE_ASSET) return refuse("ASSET_NOT_SUPPORTED", "adapter only executes native NEAR transfers", pre);
    const recipient = checkNearAccountId(pre.recipientId);
    if (!recipient.ok) return refuse("ADAPTER_VALIDATION_FAILED", recipient.message, pre);
    if (!isTestnetSigner(this.client.signerAccountId)) {
      return refuse("SIGNER_NOT_TESTNET", "signer account is not a testnet account", pre);
    }

    let networkId: string;
    try {
      networkId = await this.withTimeout(this.client.getNetworkId(), "RPC network check");
    } catch (err) {
      return refuse("RPC_UNAVAILABLE", `could not confirm RPC network: ${(err as Error).message}`, pre);
    }
    if (networkId !== "testnet") return refuse("RPC_NOT_TESTNET", `RPC reports network "${networkId}", expected "testnet"`, pre);

    // The execution gate: atomic reserved -> submitted, policy-version check.
    const gate = await this.engine.beginExecution(reservationId);
    if (!gate.ok) return refuse(gate.reason.code, gate.reason.message, gate.reservation);
    const reservation = gate.reservation;

    let tx: NearTxView;
    try {
      tx = await this.withTimeout(this.client.transfer(reservation.recipientId, reservation.amountAtomic), "transfer");
    } catch (err) {
      return {
        status: "unknown",
        reservation,
        message: `transfer outcome unknown (${(err as Error).message}); reservation left as submitted and still counts toward limits. Reconcile with the transaction hash if one is known.`,
      };
    }
    const hash = typeof tx?.transaction_outcome?.id === "string" ? tx.transaction_outcome.id : undefined;
    if (!hash) {
      return { status: "unknown", reservation, message: "network response contained no transaction hash; reservation left as submitted" };
    }
    return this.record(reservation.reservationId, hash, classifyStatus(tx.status));
  }

  /**
   * Re-check a submitted reservation against the network. The hash must be the one
   * recorded for this reservation; if none was recorded (the broadcast outcome was
   * ambiguous), the on-chain transaction must match the reservation's signer, receiver
   * and exact amount. An unrelated hash can therefore never settle a reservation.
   */
  async reconcile(reservationId: string, transactionHash: string): Promise<NearExecutionResult> {
    let reservation: Reservation | undefined;
    try {
      reservation = await this.engine.getReservation(reservationId);
    } catch (err) {
      return { status: "unknown", transactionHash, message: `ledger unavailable: ${(err as Error).message}` };
    }
    if (!reservation) return { status: "refused", reasonCode: "RESERVATION_NOT_FOUND", transactionHash, message: "no such reservation" };
    if (reservation.status !== "submitted") {
      return { status: "refused", reasonCode: "INVALID_STATE_TRANSITION", transactionHash, reservation, message: `reservation is ${reservation.status}` };
    }
    if (reservation.transactionReference !== undefined && reservation.transactionReference !== transactionHash) {
      return {
        status: "refused",
        reasonCode: "TRANSACTION_MISMATCH",
        transactionHash,
        reservation,
        message: "hash does not match the transaction recorded for this reservation",
      };
    }
    let tx: NearTxView;
    try {
      tx = await this.withTimeout(this.client.transactionStatus(transactionHash), "status query");
    } catch (err) {
      return { status: "unknown", transactionHash, reservation, message: `status query failed: ${(err as Error).message}` };
    }
    if (tx?.transaction_outcome?.id !== transactionHash) {
      return { status: "unknown", transactionHash, reservation, message: "status response did not match the requested transaction" };
    }
    if (reservation.transactionReference === undefined && !transactionMatches(tx, this.client.signerAccountId, reservation)) {
      return {
        status: "refused",
        reasonCode: "TRANSACTION_MISMATCH",
        transactionHash,
        reservation,
        message: "on-chain transaction does not match this reservation (signer, receiver or amount)",
      };
    }
    return this.record(reservationId, transactionHash, classifyStatus(tx.status));
  }

  private async record(reservationId: string, hash: string, outcome: "confirmed" | "failed" | "pending"): Promise<NearExecutionResult> {
    if (outcome === "pending") {
      // Store the network's hash so reconcile() can only settle this exact transaction.
      // Whatever happens, the hash from the network is still returned to the caller.
      let reservation: Reservation | undefined;
      let note = "";
      try {
        const r = await this.engine.recordTransactionReference(reservationId, hash);
        reservation = r.reservation;
        if (!r.ok) note = ` (could not store the hash: ${r.reason.message})`;
      } catch (err) {
        note = ` (could not store the hash: ${(err as Error).message})`;
      }
      return {
        status: "pending",
        transactionHash: hash,
        ...(reservation ? { reservation } : {}),
        message: `transaction not final yet; reservation remains submitted${note}`,
      };
    }
    const r = await this.engine.recordOutcome(reservationId, outcome, { transactionReference: hash });
    return {
      status: outcome,
      transactionHash: hash,
      ...(r.reservation ? { reservation: r.reservation } : {}),
      message: r.ok ? `transaction ${outcome}` : `transaction ${outcome}, but recording failed: ${r.reason.message}`,
    };
  }

  private withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}
