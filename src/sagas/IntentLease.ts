export interface SagaIntentLease {
  readonly intentKey: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

export interface AcquireSagaIntentLeaseInput {
  readonly intentKey: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: string | Date;
}

export interface ReleaseSagaIntentLeaseInput {
  readonly intentKey: string;
  readonly workerId: string;
  readonly leaseId: string;
  readonly now?: string | Date;
}

export interface SagaIntentLeaseStore {
  acquireLease(input: AcquireSagaIntentLeaseInput): Promise<SagaIntentLease | undefined>;
  releaseLease(input: ReleaseSagaIntentLeaseInput): Promise<boolean>;
  getActiveLease(intentKey: string, now?: string | Date): Promise<SagaIntentLease | undefined>;
}

interface MutableSagaIntentLease {
  intentKey: string;
  workerId: string;
  leaseId: string;
  fencingToken: number;
  leasedAt: string;
  expiresAt: string;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function cloneLease(lease: MutableSagaIntentLease): SagaIntentLease {
  return {
    intentKey: lease.intentKey,
    workerId: lease.workerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    leasedAt: lease.leasedAt,
    expiresAt: lease.expiresAt
  };
}

/**
 * S20 in-memory lease store abstraction for intent execution workers.
 * Guarantees that at most one active lease exists per intent key.
 */
export class InMemorySagaIntentLeaseStore implements SagaIntentLeaseStore {
  private readonly leasesByIntentKey = new Map<string, MutableSagaIntentLease>();

  private readonly fencingTokensByIntentKey = new Map<string, number>();

  async acquireLease(input: AcquireSagaIntentLeaseInput): Promise<SagaIntentLease | undefined> {
    const now = toDate(input.now ?? new Date());
    const existing = this.getLeaseIfActive(input.intentKey, now);

    if (existing) {
      return undefined;
    }

    const fencingToken = (this.fencingTokensByIntentKey.get(input.intentKey) ?? 0) + 1;
    this.fencingTokensByIntentKey.set(input.intentKey, fencingToken);

    const lease: MutableSagaIntentLease = {
      intentKey: input.intentKey,
      workerId: input.workerId,
      leaseId: `${input.intentKey}:${fencingToken}`,
      fencingToken,
      leasedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.leaseDurationMs).toISOString()
    };

    this.leasesByIntentKey.set(input.intentKey, lease);
    return cloneLease(lease);
  }

  async releaseLease(input: ReleaseSagaIntentLeaseInput): Promise<boolean> {
    const now = toDate(input.now ?? new Date());
    const existing = this.getLeaseIfActive(input.intentKey, now);

    if (!existing) {
      return false;
    }

    if (existing.workerId !== input.workerId || existing.leaseId !== input.leaseId) {
      return false;
    }

    this.leasesByIntentKey.delete(input.intentKey);
    return true;
  }

  async getActiveLease(intentKey: string, now: string | Date = new Date()): Promise<SagaIntentLease | undefined> {
    const active = this.getLeaseIfActive(intentKey, toDate(now));
    return active ? cloneLease(active) : undefined;
  }

  private getLeaseIfActive(intentKey: string, now: Date): MutableSagaIntentLease | undefined {
    const lease = this.leasesByIntentKey.get(intentKey);

    if (!lease) {
      return undefined;
    }

    if (new Date(lease.expiresAt).getTime() <= now.getTime()) {
      this.leasesByIntentKey.delete(intentKey);
      return undefined;
    }

    return lease;
  }
}
