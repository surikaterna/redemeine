import { counter, primitive } from './definitions';

export const badState = { ...counter, initialState: undefined };
export const badCommand = { ...counter, commandCreators: { broken: () => ({ payload: undefined }) } };
export const voidCommand = { ...counter, commandCreators: { broken: () => ({ payload: undefined as void }) } };
export const anyCommand = { ...counter, commandCreators: { broken: () => ({ payload: JSON.parse('null') }) } };
export const badEvent = { ...counter, pure: { eventProjectors: { broken: (state: object, event: { payload: undefined }) => {} } } };
export const missingPayload = { ...counter, commandCreators: { broken: () => ({ unrelated: 1 }) } };
export const missingEvent = { ...counter, pure: { eventProjectors: { broken: () => {} } } };
export const genericCommand = { ...counter, commandCreators: { broken: <T>(payload: T) => ({ payload }) } };
declare function overloaded(): { payload: string };
declare function overloaded(value: number): { payload: number };
export const overloadedCommand = { ...counter, commandCreators: { broken: overloaded } };
export const optionalCommand = { ...counter, commandCreators: {} as { broken?: () => { payload: string } } };
export const indexedCommands = { ...counter, commandCreators: {} as Record<string, () => { payload: string }> };
export const badProjection = { ...primitive, initialState: () => ({ bad: undefined }) };
export const builder = { aggregateType: 'builder' as const };
export const emptyAggregate = { ...counter, commandCreators: {}, pure: { eventProjectors: {} } };
export const protoHandler = { ...counter, commandCreators: { ['__proto__']: () => ({ payload: 1 }) } };
export const tupleCommand = { ...counter, commandCreators: { broken: () => ({ payload: [1, 'a'] as [number, string] }) } };
export const intersectionEvent = { ...counter, pure: { eventProjectors: { broken: (state: object, event: { payload: { a: string } & { b: number } }) => {} } } };
export const unresolvedIdentity = { ...counter, aggregateType: JSON.parse('null') };
export const stableA = {
  ...counter, aggregateType: 'stable' as const, initialState: { z: '', a: 0 },
  commandCreators: { z: () => ({ payload: { z: '', a: 0 } }), a: () => ({ payload: 0 }) },
  pure: { eventProjectors: { z: (state: object, event: { payload: { z: string; a: number } }) => {}, a: (state: object, event: { payload: number }) => {} } },
};
export const stableB = {
  ...counter, aggregateType: 'stable' as const, initialState: { a: 0, z: '' },
  commandCreators: { a: () => ({ payload: 0 }), z: () => ({ payload: { a: 0, z: '' } }) },
  pure: { eventProjectors: { a: (state: object, event: { payload: number }) => {}, z: (state: object, event: { payload: { a: number; z: string } }) => {} } },
};
