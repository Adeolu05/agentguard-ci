/**
 * Spending ledger.
 *
 * The ledger records *reservations*: amounts the policy engine has authorised and
 * that therefore count toward the agent's daily limits. It is not a wallet and is not
 * a substitute for an authoritative on-chain balance.
 *
 * Lifecycle (documented in docs/policy-schema.md#ledger-semantics):
 *
 *   reserved ──► submitted ──► confirmed
 *      │             └──────► failed
 *      └──────► cancelled
 *
 * - `reserved`, `submitted` and `confirmed` count toward daily spend and count limits.
 * - `failed` and `cancelled` release the reservation (they no longer count).
 * - `failed` must only be recorded when the transaction is *known* not to have
 *   executed. If the outcome is ambiguous (timeout, lost response) the reservation
 *   must stay `submitted`, which keeps counting: the ledger fails closed.
 * - Proposals that are blocked or still awaiting approval are never recorded.
 */

export const LIFECYCLE_STATUSES = ["reserved", "submitted", "confirmed", "failed", "cancelled"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const ACTIVE_STATUSES: ReadonlySet<LifecycleStatus> = new Set(["reserved", "submitted", "confirmed"]);

const TRANSITIONS: Record<LifecycleStatus, readonly LifecycleStatus[]> = {
  reserved: ["submitted", "cancelled"],
  submitted: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Reservation {
  readonly reservationId: string;
  readonly agentId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly proposalDigest: string;
  readonly policyHash: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly recipientId: string;
  readonly amountAtomic: bigint;
  readonly approvalId: string | undefined;
  /** ISO-8601 time the reservation was created; determines its daily window. */
  readonly createdAt: string;
  readonly status: LifecycleStatus;
  readonly transactionReference: string | undefined;
  readonly history: readonly { status: LifecycleStatus; at: string; note?: string }[];
}

export interface WindowUsage {
  /** Sum of active reservation amounts per asset, in atomic units. */
  readonly spentByAsset: ReadonlyMap<string, bigint>;
  /** Number of active reservations across all assets. */
  readonly count: number;
}

/** Operations available inside an exclusive ledger section. */
export interface LedgerSession {
  findByIdempotencyKey(agentId: string, key: string): Promise<Reservation | undefined>;
  get(reservationId: string): Promise<Reservation | undefined>;
  /** Usage of active reservations created in `[from, to)`. */
  windowUsage(agentId: string, from: Date, to: Date): Promise<WindowUsage>;
  isApprovalConsumed(approvalId: string): Promise<boolean>;
  insert(reservation: Reservation): Promise<void>;
  replace(reservation: Reservation): Promise<void>;
}

export interface Ledger {
  /**
   * Run `fn` with exclusive access to the ledger state of `agentId`. Implementations
   * MUST guarantee that no other `runExclusive` call for the same agent interleaves
   * with `fn` (e.g. a mutex in-process, or a transaction with row locks in a database).
   * This is what makes "check limit, then reserve" atomic.
   */
  runExclusive<T>(agentId: string, fn: (session: LedgerSession) => Promise<T>): Promise<T>;
  /** Read-only snapshot for reporting. */
  list(agentId?: string): Promise<readonly Reservation[]>;
}

/**
 * Reference ledger for a single process (CLI runs, tests, single-instance services).
 * Not suitable for multiple processes sharing a budget: use a database-backed
 * implementation of `Ledger` for that.
 */
export class InMemoryLedger implements Ledger {
  protected readonly records = new Map<string, Reservation>();
  protected readonly byKey = new Map<string, string>();
  protected readonly consumedApprovals = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();

  async runExclusive<T>(agentId: string, fn: (session: LedgerSession) => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => current);
    this.locks.set(agentId, tail);
    await previous;
    try {
      return await fn(this.session());
    } finally {
      release();
      if (this.locks.get(agentId) === tail) this.locks.delete(agentId);
    }
  }

  async list(agentId?: string): Promise<readonly Reservation[]> {
    await yieldTurn();
    return [...this.records.values()].filter((r) => agentId === undefined || r.agentId === agentId);
  }

  /** Seed historical entries (used by test fixtures). Bypasses policy evaluation. */
  seed(reservations: Iterable<Reservation>): void {
    for (const r of reservations) this.store(r);
  }

  protected session(): LedgerSession {
    return {
      findByIdempotencyKey: async (agentId, key) => {
        await yieldTurn();
        const id = this.byKey.get(keyOf(agentId, key));
        return id === undefined ? undefined : this.records.get(id);
      },
      get: async (id) => {
        await yieldTurn();
        return this.records.get(id);
      },
      windowUsage: async (agentId, from, to) => {
        await yieldTurn();
        const spentByAsset = new Map<string, bigint>();
        let count = 0;
        const fromMs = from.getTime();
        const toMs = to.getTime();
        for (const r of this.records.values()) {
          if (r.agentId !== agentId || !ACTIVE_STATUSES.has(r.status)) continue;
          const t = Date.parse(r.createdAt);
          if (t < fromMs || t >= toMs) continue;
          spentByAsset.set(r.assetId, (spentByAsset.get(r.assetId) ?? 0n) + r.amountAtomic);
          count++;
        }
        return { spentByAsset, count };
      },
      isApprovalConsumed: async (approvalId) => {
        await yieldTurn();
        return this.consumedApprovals.has(approvalId);
      },
      insert: async (r) => {
        await yieldTurn();
        if (this.records.has(r.reservationId)) throw new Error(`duplicate reservation ${r.reservationId}`);
        if (this.byKey.has(keyOf(r.agentId, r.idempotencyKey))) {
          throw new Error(`duplicate idempotency key for agent ${r.agentId}`);
        }
        this.store(r);
      },
      replace: async (r) => {
        await yieldTurn();
        const existing = this.records.get(r.reservationId);
        if (!existing) throw new Error(`unknown reservation ${r.reservationId}`);
        if (!canTransition(existing.status, r.status) && existing.status !== r.status) {
          throw new Error(`invalid transition ${existing.status} -> ${r.status}`);
        }
        this.records.set(r.reservationId, freezeReservation(r));
      },
    };
  }

  private store(input: Reservation): void {
    const r = freezeReservation(input);
    this.records.set(r.reservationId, r);
    this.byKey.set(keyOf(r.agentId, r.idempotencyKey), r.reservationId);
    if (r.approvalId) this.consumedApprovals.add(r.approvalId);
  }
}

/**
 * Return a deeply frozen copy of a reservation. Ledgers store and hand out only frozen
 * records, so a caller holding a reservation (e.g. from an evaluation result) cannot
 * change the amount, recipient or status the ledger accounts for.
 */
export function freezeReservation(r: Reservation): Reservation {
  if (Object.isFrozen(r) && Object.isFrozen(r.history)) return r;
  return Object.freeze({
    ...r,
    history: Object.freeze(r.history.map((h) => Object.freeze({ ...h }))),
  });
}

function keyOf(agentId: string, key: string): string {
  return `${agentId.length}:${agentId}:${key}`;
}

/**
 * Yield to the event loop so that, absent a lock, concurrent callers genuinely
 * interleave between "read usage" and "insert". This keeps concurrency tests honest.
 */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
