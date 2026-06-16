import { describe, expect, it } from 'bun:test';

import type {
  SyncEnvelope,
  CommandOnlyEnvelope,
  CommandWithEventsEnvelope,
  EventsOnlyEnvelope,
  ConflictDecision,
  EnvelopeResult,
  AuditSignal,
} from '../src/index';

import { SyncErrorCode, SyncRuntimeError } from '../src/index';

// ---------------------------------------------------------------------------
// Envelope discriminated union narrowing
// ---------------------------------------------------------------------------

describe('SyncEnvelope discriminated union', () => {
  const commandOnly: SyncEnvelope = {
    type: 'command_only',
    envelopeId: 'env-1',
    commandId: 'cmd-1',
    aggregateType: 'Order',
    aggregateId: 'order-1',
    commandType: 'PlaceOrder',
    payload: { item: 'widget' },
    occurredAt: '2026-01-01T00:00:00Z',
  };

  const commandWithEvents: SyncEnvelope = {
    type: 'command_with_events',
    envelopeId: 'env-2',
    commandId: 'cmd-2',
    aggregateType: 'Order',
    aggregateId: 'order-2',
    commandType: 'ConfirmOrder',
    payload: {},
    events: [{ type: 'OrderConfirmed', payload: {} }],
    occurredAt: '2026-01-01T00:00:00Z',
  };

  const eventsOnly: SyncEnvelope = {
    type: 'events_only',
    envelopeId: 'env-3',
    aggregateType: 'Order',
    aggregateId: 'order-3',
    events: [{ type: 'OrderShipped', payload: {} }],
    occurredAt: '2026-01-01T00:00:00Z',
  };

  it('narrows to CommandOnlyEnvelope', () => {
    if (commandOnly.type === 'command_only') {
      const narrow: CommandOnlyEnvelope = commandOnly;
      expect(narrow.commandId).toBe('cmd-1');
      expect(narrow.commandType).toBe('PlaceOrder');
    } else {
      throw new Error('Expected command_only');
    }
  });

  it('narrows to CommandWithEventsEnvelope', () => {
    if (commandWithEvents.type === 'command_with_events') {
      const narrow: CommandWithEventsEnvelope = commandWithEvents;
      expect(narrow.events).toHaveLength(1);
      expect(narrow.events[0].type).toBe('OrderConfirmed');
    } else {
      throw new Error('Expected command_with_events');
    }
  });

  it('narrows to EventsOnlyEnvelope', () => {
    if (eventsOnly.type === 'events_only') {
      const narrow: EventsOnlyEnvelope = eventsOnly;
      expect(narrow.events).toHaveLength(1);
      // events_only has no commandId or commandType
      expect('commandId' in narrow).toBe(false);
    } else {
      throw new Error('Expected events_only');
    }
  });

  it('exhaustive switch covers all variants', () => {
    const envelopes: ReadonlyArray<SyncEnvelope> = [
      commandOnly,
      commandWithEvents,
      eventsOnly,
    ];

    const types = envelopes.map((env) => {
      switch (env.type) {
        case 'command_only':
          return 'co';
        case 'command_with_events':
          return 'cwe';
        case 'events_only':
          return 'eo';
        default: {
          const _exhaustive: never = env;
          throw new Error(`Unhandled: ${_exhaustive}`);
        }
      }
    });

    expect(types).toEqual(['co', 'cwe', 'eo']);
  });
});

// ---------------------------------------------------------------------------
// ConflictDecision discriminated union narrowing
// ---------------------------------------------------------------------------

describe('ConflictDecision discriminated union', () => {
  it('narrows accept', () => {
    const d: ConflictDecision = { decision: 'accept' };
    if (d.decision === 'accept') {
      expect(d.decision).toBe('accept');
    } else {
      throw new Error('Expected accept');
    }
  });

  it('narrows reject with reason', () => {
    const d: ConflictDecision = { decision: 'reject', reason: 'stale' };
    if (d.decision === 'reject') {
      expect(d.reason).toBe('stale');
    } else {
      throw new Error('Expected reject');
    }
  });

  it('narrows override with events', () => {
    const d: ConflictDecision = {
      decision: 'override',
      events: [{ type: 'Corrected' }],
    };
    if (d.decision === 'override') {
      expect(d.events).toHaveLength(1);
    } else {
      throw new Error('Expected override');
    }
  });
});

// ---------------------------------------------------------------------------
// EnvelopeResult discriminated union narrowing
// ---------------------------------------------------------------------------

describe('EnvelopeResult discriminated union', () => {
  it('narrows accepted', () => {
    const r: EnvelopeResult = { status: 'accepted', envelopeId: 'e-1' };
    if (r.status === 'accepted') {
      expect(r.envelopeId).toBe('e-1');
    }
  });

  it('narrows duplicate', () => {
    const r: EnvelopeResult = { status: 'duplicate', envelopeId: 'e-2' };
    if (r.status === 'duplicate') {
      expect(r.envelopeId).toBe('e-2');
    }
  });

  it('narrows rejected with reason', () => {
    const r: EnvelopeResult = {
      status: 'rejected',
      envelopeId: 'e-3',
      reason: 'bad payload',
    };
    if (r.status === 'rejected') {
      expect(r.reason).toBe('bad payload');
    }
  });

  it('narrows conflict_resolved with decision', () => {
    const r: EnvelopeResult = {
      status: 'conflict_resolved',
      envelopeId: 'e-4',
      decision: { decision: 'accept' },
    };
    if (r.status === 'conflict_resolved') {
      expect(r.decision.decision).toBe('accept');
    }
  });

  it('exhaustive switch covers all result variants', () => {
    const results: ReadonlyArray<EnvelopeResult> = [
      { status: 'accepted', envelopeId: 'a' },
      { status: 'duplicate', envelopeId: 'b' },
      { status: 'rejected', envelopeId: 'c', reason: 'x' },
      { status: 'conflict_resolved', envelopeId: 'd', decision: { decision: 'accept' } },
    ];

    const statuses = results.map((r) => {
      switch (r.status) {
        case 'accepted':
          return 'a';
        case 'duplicate':
          return 'd';
        case 'rejected':
          return 'r';
        case 'conflict_resolved':
          return 'cr';
        default: {
          const _exhaustive: never = r;
          throw new Error(`Unhandled: ${_exhaustive}`);
        }
      }
    });

    expect(statuses).toEqual(['a', 'd', 'r', 'cr']);
  });
});

// ---------------------------------------------------------------------------
// AuditSignal discriminated union narrowing
// ---------------------------------------------------------------------------

describe('AuditSignal discriminated union', () => {
  it('exhaustive switch covers all signal types', () => {
    const signals: ReadonlyArray<AuditSignal> = [
      { type: 'accepted', envelopeId: 'e1', aggregateType: 'A', aggregateId: 'a1' },
      { type: 'duplicate', envelopeId: 'e2', aggregateType: 'A', aggregateId: 'a2' },
      { type: 'rejected', envelopeId: 'e3', reason: 'bad' },
      { type: 'conflict', envelopeId: 'e4', aggregateType: 'A', aggregateId: 'a4', decision: 'accept' },
      { type: 'batch_failed', envelopeId: 'e5', reason: 'boom' },
    ];

    const types = signals.map((s) => {
      switch (s.type) {
        case 'accepted':
          return 'acc';
        case 'duplicate':
          return 'dup';
        case 'rejected':
          return 'rej';
        case 'conflict':
          return 'con';
        case 'batch_failed':
          return 'bf';
        default: {
          const _exhaustive: never = s;
          throw new Error(`Unhandled: ${_exhaustive}`);
        }
      }
    });

    expect(types).toEqual(['acc', 'dup', 'rej', 'con', 'bf']);
  });
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

describe('SyncErrorCode', () => {
  it('all codes are unique strings', () => {
    const values = Object.values(SyncErrorCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    expect(values.length).toBe(5);
  });

  it('contains expected codes', () => {
    expect(SyncErrorCode.UNKNOWN_AGGREGATE).toBe('UNKNOWN_AGGREGATE');
    expect(SyncErrorCode.MALFORMED_ENVELOPE).toBe('MALFORMED_ENVELOPE');
    expect(SyncErrorCode.SEQUENCE_GAP).toBe('SEQUENCE_GAP');
    expect(SyncErrorCode.EVENTS_ONLY_NOT_SUPPORTED).toBe('EVENTS_ONLY_NOT_SUPPORTED');
    expect(SyncErrorCode.PROCESSING_ERROR).toBe('PROCESSING_ERROR');
  });
});

describe('SyncRuntimeError', () => {
  it('extends Error with code and message', () => {
    const err = new SyncRuntimeError(
      SyncErrorCode.UNKNOWN_AGGREGATE,
      'Aggregate "Foo" is not registered',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SyncRuntimeError');
    expect(err.code).toBe('UNKNOWN_AGGREGATE');
    expect(err.message).toBe('Aggregate "Foo" is not registered');
  });

  it('each error code produces a distinct error', () => {
    const codes = Object.values(SyncErrorCode);
    const errors = codes.map((c) => new SyncRuntimeError(c, `test-${c}`));
    const uniqueCodes = new Set(errors.map((e) => e.code));
    expect(uniqueCodes.size).toBe(codes.length);
  });
});
