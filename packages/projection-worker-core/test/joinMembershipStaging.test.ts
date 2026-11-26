import { expect, jest, test } from '@jest/globals';
import { joinMembershipKey, MAX_JOIN_TURN_KEYS } from '@redemeine/projection-runtime-core';
import { JoinMembershipStaging } from '../src/joinMembershipReduction';

const source = { aggregateType: 'Order', aggregateId: 'one' };
const key = joinMembershipKey(source.aggregateType, source.aggregateId);
const ids = Array.from({ length: 1024 }, (_, index) => `${String(index).padStart(4, '0')}${'é'.repeat(500)}`);
const row = (targetDocumentIds: readonly string[]) => ({ ...source, revision: 1, targetDocumentIds });

test('idempotent staging is bounded by lookups, not whole-set copies, sorting or encoding', () => {
  let indexedReads = 0;
  const prior = row(new Proxy(ids, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    }
  }));
  const staging = new JoinMembershipStaging(new Map([[key, prior]]));
  const missing = new Map();
  const encode = jest.spyOn(TextEncoder.prototype, 'encode');
  try {
    for (const id of ids) {
      staging.stage(missing, source, id, true);
      staging.stage(missing, source, `${id}x`, false);
    }
    staging.finishEvent();
    expect(staging.rows.get(key)).toBe(prior);
    expect(indexedReads).toBeLessThanOrEqual(11 * ids.length * 2);
    expect(encode.mock.calls.every(([value]) => value === key)).toBe(true);
  } finally {
    encode.mockRestore();
  }
});

test('event-local edits can exceed the encoded byte cap only until the end of the event', () => {
  const staging = new JoinMembershipStaging(new Map([[key, row(ids.slice(1))]]));
  const missing = new Map();
  const extra = '\\'.repeat(32_000);
  staging.stage(missing, source, extra, true);
  staging.stage(missing, source, extra, false);
  staging.finishEvent();
  expect(staging.rows.get(key)?.targetDocumentIds).toEqual(ids.slice(1));
  staging.stage(missing, source, extra, true);
  expect(() => staging.finishEvent()).toThrow(/bytes exceed capacity/);
});

test('repeated idempotent stage calls still consume a finite turn budget', () => {
  const staging = new JoinMembershipStaging(new Map([[key, row([])]]));
  const missing = new Map();
  for (let index = 0; index < MAX_JOIN_TURN_KEYS; index += 1) staging.stage(missing, source, 'absent', false);
  expect(() => staging.stage(missing, source, 'absent', false)).toThrow(/exceeds capacity/);
});
