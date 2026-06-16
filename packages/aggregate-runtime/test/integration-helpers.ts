/**
 * Shared in-memory fakes and test helpers for integration tests.
 * Each factory returns fresh instances — tests remain self-contained.
 */

import type {
  IIdempotencyStore,
  IOrderingStore,
  IAuditSink,
  IDepot,
  AuditSignal,
  AggregateInstance,
  AggregateRegistration,
  AggregateRuntimeOptions,
  CommandOnlyEnvelope,
  CommandWithEventsEnvelope,
  ConflictResolver,
} from '../src/index';

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

export type InMemoryIdempotencyStore = IIdempotencyStore & {
  readonly reserved: Set<string>;
};

export function createInMemoryIdempotencyStore(): InMemoryIdempotencyStore {
  const reserved = new Set<string>();
  return {
    reserved,
    async reserve(envelopeId: string): Promise<boolean> {
      if (reserved.has(envelopeId)) {
        return false;
      }
      reserved.add(envelopeId);
      return true;
    },
    async isProcessed(envelopeId: string): Promise<boolean> {
      return reserved.has(envelopeId);
    },
  };
}

export type InMemoryOrderingStore = IOrderingStore & {
  readonly sequences: Map<string, number>;
};

export function createInMemoryOrderingStore(): InMemoryOrderingStore {
  const sequences = new Map<string, number>();
  return {
    sequences,
    async getLastSequence(
      aggregateType: string,
      aggregateId: string,
    ): Promise<number | undefined> {
      return sequences.get(`${aggregateType}:${aggregateId}`);
    },
    async saveSequence(
      aggregateType: string,
      aggregateId: string,
      sequence: number,
    ): Promise<void> {
      sequences.set(`${aggregateType}:${aggregateId}`, sequence);
    },
  };
}

export type SavedEntry = {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly events: ReadonlyArray<unknown>;
};

export type InMemoryDepot = IDepot & {
  readonly saved: SavedEntry[];
};

export function createInMemoryDepot(
  instances?: Record<string, AggregateInstance>,
): InMemoryDepot {
  const store = new Map<string, AggregateInstance>();
  if (instances) {
    for (const [key, value] of Object.entries(instances)) {
      store.set(key, value);
    }
  }
  const saved: SavedEntry[] = [];
  return {
    saved,
    async get(
      aggregateType: string,
      aggregateId: string,
    ): Promise<AggregateInstance | undefined> {
      return store.get(`${aggregateType}:${aggregateId}`);
    },
    async save(
      aggregateType: string,
      aggregateId: string,
      events: ReadonlyArray<unknown>,
    ): Promise<void> {
      saved.push({ aggregateType, aggregateId, events });
    },
  };
}

export type CollectingAuditSink = IAuditSink & {
  readonly signals: AuditSignal[];
};

export function createCollectingAuditSink(): CollectingAuditSink {
  const signals: AuditSignal[] = [];
  return {
    signals,
    emit(signal: AuditSignal): void {
      signals.push(signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

export function createTestRegistration(
  aggregateType: string,
  commandHandlers: Record<string, (state: unknown, payload: unknown) => unknown>,
  conflictResolver?: ConflictResolver,
): AggregateRegistration {
  return { aggregateType, commandHandlers, conflictResolver };
}

// ---------------------------------------------------------------------------
// Envelope factories
// ---------------------------------------------------------------------------

export function makeCommandEnvelope(
  overrides?: Partial<CommandOnlyEnvelope>,
): CommandOnlyEnvelope {
  return {
    type: 'command_only',
    envelopeId: 'env-1',
    commandId: 'cmd-1',
    aggregateType: 'Counter',
    aggregateId: 'counter-1',
    commandType: 'Increment',
    payload: { amount: 1 },
    occurredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeCommandWithEventsEnvelope(
  overrides?: Partial<CommandWithEventsEnvelope>,
): CommandWithEventsEnvelope {
  return {
    type: 'command_with_events',
    envelopeId: 'env-cwe-1',
    commandId: 'cmd-cwe-1',
    aggregateType: 'Counter',
    aggregateId: 'counter-1',
    commandType: 'Increment',
    payload: { amount: 1 },
    events: [{ type: 'Incremented', payload: { amount: 1 } }],
    occurredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Common registrations
// ---------------------------------------------------------------------------

export function counterRegistration(
  conflictResolver?: ConflictResolver,
): AggregateRegistration {
  return createTestRegistration(
    'Counter',
    {
      Increment: (_state: unknown, payload: unknown) => {
        return [{ type: 'Incremented', payload }];
      },
      Reset: (_state: unknown, _payload: unknown) => {
        return [{ type: 'WasReset', payload: {} }];
      },
    },
    conflictResolver,
  );
}

export function ledgerRegistration(): AggregateRegistration {
  return createTestRegistration('Ledger', {
    PostEntry: (_state: unknown, payload: unknown) => {
      return [{ type: 'EntryPosted', payload }];
    },
  });
}

export function ticketRegistration(): AggregateRegistration {
  return createTestRegistration('Ticket', {
    Open: (_state: unknown, payload: unknown) => {
      return [{ type: 'Opened', payload }];
    },
    Close: (_state: unknown, _payload: unknown) => {
      return [{ type: 'Closed', payload: {} }];
    },
  });
}

// ---------------------------------------------------------------------------
// Options factory
// ---------------------------------------------------------------------------

export function makeOptions(
  overrides?: Partial<AggregateRuntimeOptions>,
): AggregateRuntimeOptions {
  return {
    registrations: [counterRegistration()],
    idempotencyStore: createInMemoryIdempotencyStore(),
    orderingStore: createInMemoryOrderingStore(),
    auditSink: createCollectingAuditSink(),
    depot: createInMemoryDepot(),
    ...overrides,
  };
}
