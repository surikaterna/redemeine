import { replayProjectionChangeTransition, type ProjectionChangePatchOperation, type ProjectionJsonValue } from '../src';

const replay = (state: ProjectionJsonValue, patch: readonly ProjectionChangePatchOperation[]) =>
  replayProjectionChangeTransition(state, { changeType: 'update', eventId: 'event', eventIndex: 0, patch });

test('applies array insertion, append and removal in order without mutating the baseline or earlier values', () => {
  const state = { lines: ['a', 'b', 'c'], keep: true };
  const priorValue = { 'note/~': 'before' };
  expect(replay(state, [
    { op: 'remove', path: '/lines/1' },
    { op: 'add', path: '/lines/1', value: 'd' },
    { op: 'add', path: '/lines/-', value: 'end' },
    { op: 'add', path: '/value', value: priorValue },
    { op: 'replace', path: '/value/note~1~0', value: 'after' }
  ])).toEqual({ lines: ['a', 'd', 'c', 'end'], keep: true, value: { 'note/~': 'after' } });
  expect(state.lines).toEqual(['a', 'b', 'c']);
  expect(priorValue).toEqual({ 'note/~': 'before' });
});

test('isolates shared and inserted values after index shifts and across transitions', () => {
  const shared = Object.freeze({ quantity: 1 });
  const baseline = { lines: [shared, shared], spare: shared };
  const first = replay(baseline, [
    { op: 'add', path: '/lines/0', value: shared },
    { op: 'replace', path: '/lines/0/quantity', value: 2 },
    { op: 'remove', path: '/lines/1' },
    { op: 'replace', path: '/lines/1/quantity', value: 3 },
    { op: 'replace', path: '/lines/0/quantity', value: 4 }
  ]);
  expect(first).toEqual({ lines: [{ quantity: 4 }, { quantity: 3 }], spare: { quantity: 1 } });
  expect(replay(first!, [{ op: 'replace', path: '/lines/0/quantity', value: 5 }]))
    .toEqual({ lines: [{ quantity: 5 }, { quantity: 3 }], spare: { quantity: 1 } });
  expect(first).toEqual({ lines: [{ quantity: 4 }, { quantity: 3 }], spare: { quantity: 1 } });
  expect(baseline.lines).toEqual([{ quantity: 1 }, { quantity: 1 }]);
  expect(shared.quantity).toBe(1);
});

test('rejects a path made stale earlier in the transition without changing the baseline', () => {
  const baseline = { lines: ['a', 'b'] };
  expect(replay(baseline, [
    { op: 'remove', path: '/lines/0' },
    { op: 'replace', path: '/lines/1', value: 'c' }
  ])).toBeUndefined();
  expect(baseline).toEqual({ lines: ['a', 'b'] });
});

test.each(['/lines/01', '/lines/-', '/lines/4', '/missing/field', '/constructor/prototype', '/bad~2key', '/__proto__/value'])(
  'rejects invalid or missing replace path %s', (path) => {
    expect(replay({ lines: ['a'] }, [{ op: 'replace', path, value: 0 }])).toBeUndefined();
  }
);

test('older whole-member and root replacements still replay', () => {
  expect(replay({ lines: ['a'] }, [{ op: 'replace', path: '/lines', value: ['b'] }])).toEqual({ lines: ['b'] });
  expect(replay({ lines: ['a'] }, [{ op: 'replace', path: '', value: ['b'] }])).toEqual(['b']);
});
