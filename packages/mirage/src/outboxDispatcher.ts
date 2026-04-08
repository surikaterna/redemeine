export type OutboxMessageStatus = 'pending' | 'leased' | 'dispatched' | 'retry_scheduled' | 'dead_lettered';

export interface OutboxMessage {
  readonly id: string;
  readonly deliveryKey: string;
  readonly payload: Record<string, unknown>;
  status: OutboxMessageStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  deadLetteredAt?: number;
  dispatchedAt?: number;
}

export interface OutboxLeasedMessage {
  readonly id: string;
  readonly deliveryKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
}

export interface OutboxRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface OutboxClaimRequest {
  readonly now: number;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly limit: number;
}

export interface OutboxStore {
  claimDueMessages(request: OutboxClaimRequest): Promise<OutboxLeasedMessage[]>;
  recoverExpiredLeases(now: number): Promise<number>;
  isDeliveryKeyProcessed(deliveryKey: string): Promise<boolean>;
  markDispatched(args: {
    id: string;
    leaseToken: string;
    deliveryKey: string;
    dispatchedAt: number;
    deduped: boolean;
  }): Promise<void>;
  scheduleRetry(args: {
    id: string;
    leaseToken: string;
    availableAt: number;
    attempts: number;
    error: string;
  }): Promise<void>;
  moveToDeadLetter(args: {
    id: string;
    leaseToken: string;
    attempts: number;
    error: string;
    deadLetteredAt: number;
  }): Promise<void>;
}

export type OutboxDispatchResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'transient_error'; readonly error: string }
  | { readonly kind: 'permanent_error'; readonly error: string };

export interface OutboxDispatcher {
  dispatch(message: OutboxLeasedMessage): Promise<OutboxDispatchResult>;
}

export interface OutboxWorkerOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly retryPolicy: OutboxRetryPolicy;
}

export interface OutboxRunSummary {
  readonly claimed: number;
  readonly recoveredLeases: number;
  readonly dispatched: number;
  readonly deduped: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export class OutboxDispatcherWorker {
  constructor(
    private readonly store: OutboxStore,
    private readonly dispatcher: OutboxDispatcher,
    private readonly options: OutboxWorkerOptions
  ) {}

  public async runOnce(now: number = Date.now()): Promise<OutboxRunSummary> {
    const recoveredLeases = await this.store.recoverExpiredLeases(now);
    const leased = await this.store.claimDueMessages({
      now,
      workerId: this.options.workerId,
      leaseMs: this.options.leaseMs,
      limit: this.options.batchSize
    });

    let dispatched = 0;
    let deduped = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const message of leased) {
      const alreadyProcessed = await this.store.isDeliveryKeyProcessed(message.deliveryKey);
      if (alreadyProcessed) {
        await this.store.markDispatched({
          id: message.id,
          leaseToken: message.leaseToken,
          deliveryKey: message.deliveryKey,
          dispatchedAt: now,
          deduped: true
        });
        deduped++;
        continue;
      }

      const outcome = await this.dispatchWithFailureMatrix(message);
      if (outcome.kind === 'success') {
        await this.store.markDispatched({
          id: message.id,
          leaseToken: message.leaseToken,
          deliveryKey: message.deliveryKey,
          dispatchedAt: now,
          deduped: false
        });
        dispatched++;
        continue;
      }

      const nextAttempt = message.attempts + 1;
      const exceededMaxAttempts = nextAttempt >= message.maxAttempts;

      if (outcome.kind === 'permanent_error' || exceededMaxAttempts) {
        await this.store.moveToDeadLetter({
          id: message.id,
          leaseToken: message.leaseToken,
          attempts: nextAttempt,
          error: outcome.error,
          deadLetteredAt: now
        });
        deadLettered++;
        continue;
      }

      const availableAt = now + this.computeRetryDelay(nextAttempt);
      await this.store.scheduleRetry({
        id: message.id,
        leaseToken: message.leaseToken,
        attempts: nextAttempt,
        availableAt,
        error: outcome.error
      });
      retried++;
    }

    return {
      claimed: leased.length,
      recoveredLeases,
      dispatched,
      deduped,
      retried,
      deadLettered
    };
  }

  private computeRetryDelay(attempt: number): number {
    const exponentialDelay = this.options.retryPolicy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(exponentialDelay, this.options.retryPolicy.maxDelayMs);
  }

  private async dispatchWithFailureMatrix(message: OutboxLeasedMessage): Promise<OutboxDispatchResult> {
    try {
      return await this.dispatcher.dispatch(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        kind: 'transient_error',
        error: reason
      };
    }
  }
}

export class InMemoryOutboxStore implements OutboxStore {
  private leaseCounter = 0;
  private readonly messages = new Map<string, OutboxMessage>();
  private readonly deliveryKeys = new Set<string>();

  public seed(messages: OutboxMessage[]): void {
    for (const message of messages) {
      this.messages.set(message.id, { ...message });
    }
  }

  public snapshot(id: string): OutboxMessage | undefined {
    const current = this.messages.get(id);
    return current ? { ...current } : undefined;
  }

  public async recoverExpiredLeases(now: number): Promise<number> {
    let recovered = 0;
    for (const message of this.messages.values()) {
      if (message.status === 'leased' && message.leaseExpiresAt !== undefined && message.leaseExpiresAt <= now) {
        message.status = 'pending';
        message.leaseOwner = undefined;
        message.leaseToken = undefined;
        message.leaseExpiresAt = undefined;
        recovered++;
      }
    }
    return recovered;
  }

  public async claimDueMessages(request: OutboxClaimRequest): Promise<OutboxLeasedMessage[]> {
    const claimable = Array.from(this.messages.values())
      .filter((message) => {
        const eligibleStatus = message.status === 'pending' || message.status === 'retry_scheduled';
        return eligibleStatus && message.availableAt <= request.now;
      })
      .sort((a, b) => a.availableAt - b.availableAt)
      .slice(0, request.limit);

    return claimable.map((message) => {
      const leaseToken = this.nextLeaseToken(request.workerId, message.id);
      message.status = 'leased';
      message.leaseOwner = request.workerId;
      message.leaseToken = leaseToken;
      message.leaseExpiresAt = request.now + request.leaseMs;

      return {
        id: message.id,
        deliveryKey: message.deliveryKey,
        payload: { ...message.payload },
        attempts: message.attempts,
        maxAttempts: message.maxAttempts,
        leaseToken
      };
    });
  }

  public async isDeliveryKeyProcessed(deliveryKey: string): Promise<boolean> {
    return this.deliveryKeys.has(deliveryKey);
  }

  public async markDispatched(args: {
    id: string;
    leaseToken: string;
    deliveryKey: string;
    dispatchedAt: number;
    deduped: boolean;
  }): Promise<void> {
    const message = this.assertActiveLease(args.id, args.leaseToken);
    message.status = 'dispatched';
    message.dispatchedAt = args.dispatchedAt;
    message.leaseOwner = undefined;
    message.leaseToken = undefined;
    message.leaseExpiresAt = undefined;
    message.lastError = undefined;
    this.deliveryKeys.add(args.deliveryKey);
  }

  public async scheduleRetry(args: {
    id: string;
    leaseToken: string;
    availableAt: number;
    attempts: number;
    error: string;
  }): Promise<void> {
    const message = this.assertActiveLease(args.id, args.leaseToken);
    message.status = 'retry_scheduled';
    message.availableAt = args.availableAt;
    message.attempts = args.attempts;
    message.lastError = args.error;
    message.leaseOwner = undefined;
    message.leaseToken = undefined;
    message.leaseExpiresAt = undefined;
  }

  public async moveToDeadLetter(args: {
    id: string;
    leaseToken: string;
    attempts: number;
    error: string;
    deadLetteredAt: number;
  }): Promise<void> {
    const message = this.assertActiveLease(args.id, args.leaseToken);
    message.status = 'dead_lettered';
    message.attempts = args.attempts;
    message.lastError = args.error;
    message.deadLetteredAt = args.deadLetteredAt;
    message.leaseOwner = undefined;
    message.leaseToken = undefined;
    message.leaseExpiresAt = undefined;
  }

  private assertActiveLease(id: string, leaseToken: string): OutboxMessage {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error(`Outbox message not found: ${id}`);
    }
    if (message.status !== 'leased' || message.leaseToken !== leaseToken) {
      throw new Error(`Outbox lease mismatch for message: ${id}`);
    }
    return message;
  }

  private nextLeaseToken(workerId: string, id: string): string {
    this.leaseCounter += 1;
    return `${workerId}:${id}:${this.leaseCounter}`;
  }
}
