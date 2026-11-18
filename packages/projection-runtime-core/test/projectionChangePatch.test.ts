import { isFrozenPortableProjectionChangeJson, replayProjectionChangeTransition, validateProjectionChangesState, verifyProjectionSourceCommitStatePatches,
  type ProjectionChangeTransition,
  type ProjectionChangePatchOperation, type ProjectionJsonValue } from '../src';
import { projectionChangesRequest } from './projectionChangesStoreConformance';

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

test('store proof scans the same snapshot equally for one or 32 no-ops, but still checks the final state and each patch', () => {
  let scans = 0;
  const state = new Proxy({ value: 1 }, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } });
  const snapshot = { targets: [{ targetDocumentId: 'one', state, revision: 1, sourceProgress: {} }] };
  const { additionalWrites: _ignored, ...base } = projectionChangesRequest(1);
  const check = (count: number, value = 1, malformed = false) => {
    scans = 0;
    const events = Array.from({ length: count }, (_, eventIndex) => ({
      ...base.commit.events[0], eventIndex, eventId: `event-${eventIndex}`
    })) as unknown as typeof base.commit.events;
    const transitions = events.map(({ eventIndex, eventId }) => ({ eventIndex, eventId, changeType: 'noop' as const,
      patch: malformed && eventIndex === count - 1 ? [{ op: 'remove' as const, path: '/value' }] : []
    }));
    const verified = verifyProjectionSourceCommitStatePatches({ ...base, commit: { ...base.commit, events },
      finalDocuments: [{ ...base.finalDocuments[0]!, finalDocument: { value }, statePatch: { kind: 'ordered', transitions } }]
    }, snapshot);
    return { scans, unchanged: verified.get('one')?.unchanged };
  };
  const single = check(1);
  expect(single).toMatchObject({ unchanged: true });
  expect(single.scans).toBeGreaterThan(0);
  expect(check(32)).toEqual(single);
  expect(check(32, 2).unchanged).toBeUndefined();
  expect(check(32, 1, true).unchanged).toBeUndefined();
});

test('portability proof cannot be cached for a shallow-frozen graph', () => {
  expect(isFrozenPortableProjectionChangeJson(Object.freeze({ nested: { value: 1 } }))).toBe(false);
  expect(isFrozenPortableProjectionChangeJson(Object.freeze({ nested: Object.freeze({ value: 1 }) }))).toBe(true);
});

test('history still rejects a changed, nonportable intermediate even if later patches restore the original', () => {
  const request = projectionChangesRequest(1);
  const first = request.commit.events[0];
  const second = { ...first, eventIndex: 1, eventId: 'second' };
  const transitions: ProjectionChangeTransition[] = [
    { eventIndex: 0, eventId: first.eventId, changeType: 'update',
      patch: [{ op: 'add', path: '/$ref', value: 'refs' }, { op: 'add', path: '/$id', value: 'one' }] },
    { eventIndex: 1, eventId: second.eventId, changeType: 'update',
      patch: [{ op: 'remove', path: '/$ref' }, { op: 'remove', path: '/$id' }] }
  ];
  const { finalDocument: state } = request.finalDocuments[0]!;
  const snapshot = { targets: [{ targetDocumentId: 'one', revision: 1, sourceProgress: {}, state }] };
  expect(validateProjectionChangesState({ ...request, commit: { ...request.commit, events: [first, second] },
    additionalWrites: [{ ...request.additionalWrites![0], targets: [{ targetDocumentId: 'one', transitions }] }]
  }, snapshot)).toMatch(/cannot be applied as portable JSON/);
});
