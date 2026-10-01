import type { ProjectionDefinition } from '../../../../packages/projection/src';

type Definition<T> = ProjectionDefinition<T>;
export declare const unknownState: Definition<unknown>;
export declare const anyState: Definition<ReturnType<typeof JSON.parse>>;
export declare const undefinedState: Definition<{ value: string | undefined }>;
export declare const undefinedOptional: Definition<{ value?: undefined }>;
export declare const functionState: Definition<{ value: () => string }>;
export declare const tupleState: Definition<[string, number]>;
export declare const mixedState: Definition<{ [key: string]: string; required: string }>;
export declare const numericState: Definition<Record<number, string>>;
export declare const symbolState: Definition<Record<symbol, string>>;
declare const businessSymbol: unique symbol;
export declare const computedSymbolState: Definition<{ [businessSymbol]: string; normal: number }>;
export declare const mappedSymbolState: Definition<Record<typeof businessSymbol, string>>;
export declare const wellKnownSymbolState: Definition<{ [Symbol.toStringTag]: string; normal: number }>;
export declare const intersectionState: Definition<{ a: string } & { b: number }>;
export declare const promiseState: Definition<Promise<string>>;
interface Cycle { next?: Cycle }
export declare const cycleState: Definition<Cycle>;
class Custom { value = 0 }
export declare const classState: Definition<Custom>;
export declare const prototypeState: Definition<{ '__proto__': string }>;
// Deliberately unresolved contract used to prove extraction never substitutes z.any().
// @ts-expect-error Deliberate unresolved type; the checker must reject the error type.
export declare const unresolvedState: Definition<MissingContract>;
export declare const emptyState: Definition<{}>;
export declare const infiniteState: Definition<1e999>;
// @ts-expect-error Deliberate unresolved base; inherited fields must not be erased.
interface UnresolvedBase extends MissingBase { known: string }
export declare const unresolvedBaseState: Definition<UnresolvedBase>;
type Deep<T extends unknown[] = []> = T['length'] extends 65 ? string : { next: Deep<[...T, unknown]> };
export declare const deepState: Definition<Deep>;
export declare const arrayUndefinedState: Definition<{ values?: (string | undefined)[] }>;
export declare const optionalFactory: { name: string; fromStream: {}; identity: () => string; subscriptions: []; initialState?: () => string };
export declare const aggregateValue: { name: string; fromStream: {}; identity: () => string; subscriptions: []; initialState: {} };
export declare const overloadedFactory: { name: string; fromStream: {}; identity: () => string; subscriptions: []; initialState: { (): string; (id: string): number } };
export declare const genericFactory: { name: string; fromStream: {}; identity: () => string; subscriptions: []; initialState: <T>() => T };
