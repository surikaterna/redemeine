import { current, original } from 'immer';
import {
  captureProjectionSourceEvent, isOwnedProjectionState, ownProjectionState, registerNativeProjectionCaptureSnapshot
} from '../src/contracts/projectionChangeCapture';

const event = {
  eventId: 'event', eventIndex: 0, streamVersion: 0, type: 'Changed',
  aggregateId: 'one', aggregateType: 'Order', timestamp: '2026-11-19T00:00:00.000Z', payload: {}
};

function expectInvalid(invalid: unknown): void {
  const valid = { scalar: 1 };
  // The valid sibling is visited before the invalid branch.
  const root = { invalid, valid };
  expect(ownProjectionState(root)).toBe(false);
  expect(isOwnedProjectionState(root)).toBe(false);
  expect(isOwnedProjectionState(valid)).toBe(false);
  expect(Object.isFrozen(valid)).toBe(false);
}

test('rejects accessors and proxies without evaluating them or publishing partial ownership', () => {
  const evaluate = jest.fn(() => { throw new Error('must not evaluate'); });
  expectInvalid({ get accessor() { return evaluate(); } });
  expectInvalid(new Proxy({}, { getPrototypeOf: evaluate, ownKeys: evaluate, getOwnPropertyDescriptor: evaluate }));
  expect(evaluate).not.toHaveBeenCalled();
});

test('rejects cycles and non-plain containers without claiming valid siblings', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  expectInvalid(cyclic);
  expectInvalid(new Map());
  expectInvalid(new Set());
  expectInvalid({ nested: Symbol() });
});

test('seals a shared child even when its outer container was shallow-frozen', () => {
  const child = { value: 1 };
  const frozen = Object.freeze({ child });
  const root = { left: frozen, right: frozen };
  expect(ownProjectionState(root)).toBe(true);
  expect(root.left).toBe(root.right);
  expect(isOwnedProjectionState(child)).toBe(true);
  expect(Object.isFrozen(child)).toBe(true);
});

test('retains structural sharing and protects leaked originals and assigned values after a recipe', async () => {
  const before = { nested: { value: 1 }, assigned: { value: 0 } };
  const external = { value: 1 };
  let leaked: typeof before | undefined;
  const { state, transition } = captureProjectionSourceEvent(before, event, draft => {
    leaked = original(draft);
    expect(() => { leaked!.nested.value++; }).toThrow(TypeError);
    draft.assigned = external;
    draft.assigned.value++;
  }, false);
  expect(state.nested).toBe(before.nested);
  expect(state.assigned.value).toBe(2);
  expect(transition?.patch).toEqual([{ op: 'replace', path: '/assigned', value: { value: 2 } }]);
  await Promise.resolve().then(() => {
    expect(() => { leaked!.nested.value++; }).toThrow(TypeError);
    expect(() => { external.value++; }).toThrow(TypeError);
  });
  expect(state.assigned.value).toBe(2);
});

test('native capture supports synchronous draft edits and read-only original/current, without freezing payloads', () => {
  const before = { nested: { count: 1 }, assigned: { count: 0 } };
  const external = { count: 2 };
  const snapshot = { targets: [{ targetDocumentId: 'one', revision: 1, state: before, sourceProgress: {} }],
    links: [], ownRecordSequence: null };
  registerNativeProjectionCaptureSnapshot(snapshot);
  const { state, transition } = captureProjectionSourceEvent(before, event, draft => {
    expect(original(draft)?.nested.count).toBe(1);
    draft.assigned = external;
    draft.assigned.count++;
    expect(current(draft).assigned.count).toBe(3);
  }, false, { snapshot, targetId: 'one' });
  expect(state.nested).toBe(before.nested);
  expect(state.assigned).toBe(external);
  expect(transition?.patch).toEqual([{ op: 'replace', path: '/assigned', value: { count: 3 } }]);
  // Mutating these aliases outside the recipe is not supported; freezing is not the native guard.
  expect(Object.isFrozen(before.nested)).toBe(false);
  expect(Object.isFrozen(state.assigned)).toBe(false);
  expect(Object.isFrozen(transition?.patch)).toBe(true);
});
