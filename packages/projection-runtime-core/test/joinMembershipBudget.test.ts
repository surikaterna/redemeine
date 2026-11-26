import { Buffer } from 'node:buffer';
import { expect, jest, test } from '@jest/globals';
import {
  JOIN_MEMBERSHIP_FENCE_CAPACITY, MAX_JOIN_TARGET_BYTES, MAX_JOIN_TURN_BYTES, MAX_JOIN_TURN_KEYS, measureJoinTargetSet,
  validateJoinMembershipFences, type ProjectionJoinMembershipFence
} from '../src';

const scope = { projectionName: 'p', projectionGeneration: 'g\\' };
const fence = (aggregateId: string, targetDocumentIds: readonly string[] = []): ProjectionJoinMembershipFence =>
  ({ aggregateType: 'Order', aggregateId, expectedRevision: null, targetDocumentIds });

test('counts raw UTF-8 and the exact JSON row boundary, including Unicode and escapes', () => {
  const escapes = '\0\b\t\n\f\r"\\\u001fé🦄';
  const space = MAX_JOIN_TARGET_BYTES - Buffer.byteLength(JSON.stringify([escapes]));
  const id = escapes + 'x'.repeat(space);
  expect(measureJoinTargetSet([id])).toBe(Buffer.byteLength(id));
  expect(() => measureJoinTargetSet([`${id}x`])).toThrow(/target bytes exceed capacity/);
});

test('measures each target occurrence once without encoding whole rows', () => {
  const repeated = 'same-é🦄';
  const rows = [fence('one', [repeated]), fence('two', [repeated]), fence('three', [repeated])];
  const measure = jest.spyOn(Buffer, 'byteLength');
  const encode = jest.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(validateJoinMembershipFences(rows, scope)).toBeNull();
    expect(measure.mock.calls.filter(([value]) => value === repeated)).toHaveLength(rows.length);
    expect(encode).not.toHaveBeenCalled();
  } finally {
    measure.mockRestore();
    encode.mockRestore();
  }
});

test('fence keys have a separate bound, including empty rows and scoped tuple escaping', () => {
  const rows = Array.from({ length: MAX_JOIN_TURN_KEYS }, (_, index) => fence(String(index)));
  expect(validateJoinMembershipFences(rows, scope)).toBeNull();
  expect(validateJoinMembershipFences([...rows, fence('over')], scope)).toBe(JOIN_MEMBERSHIP_FENCE_CAPACITY);
  const overhead = Buffer.byteLength(JSON.stringify([scope.projectionName, scope.projectionGeneration, 'Order', '']));
  const exact = 'a'.repeat(MAX_JOIN_TURN_BYTES - overhead);
  expect(validateJoinMembershipFences([fence(exact)], scope)).toBeNull();
  expect(validateJoinMembershipFences([fence(`${exact}a`)], scope)).toBe(JOIN_MEMBERSHIP_FENCE_CAPACITY);
});
