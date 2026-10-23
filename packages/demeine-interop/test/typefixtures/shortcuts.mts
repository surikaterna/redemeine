import { createAggregate } from '@redemeine/aggregate';
import {
  createDemeineBridge, type BridgeArguments, type BridgeConstructor,
  type BridgeableAggregate, type BridgeCommand, type CommandSink,
} from '@redemeine/demeine-interop';

const definition = createAggregate('payment', { count: 0 })
  .events({})
  .commands(() => ({
    confirm: (_state: unknown, _payload: { reason?: string }) => [],
    register: (_state: unknown, _payload: { id: string }) => [],
    empty: () => [],
    optional: { pack: (payload?: { reason: string }) => payload, handler: () => [] },
    multiple: { pack: (id: string, reason?: string) => ({ id, reason }), handler: () => [] },
  }))
  .build();

// A host helper keeps the actual overloaded public constructor, not a recreated cast.
function hostBridge<S extends object, C extends Record<string, (...args: never) => BridgeCommand>>(
  built: BridgeableAggregate<S, C>,
): BridgeConstructor<S, C> {
  return createDemeineBridge(built);
}
const Base = hostBridge(definition);
class Payment extends Base {
  confirmWithReason(reason: string) { return this.confirm({ reason }); }
}
declare const sink: CommandSink<{ count: number }>;
new Payment(sink);
const payment = new Payment();
payment.confirm();
payment.confirm({});
payment.confirm({ reason: 'ok' });
payment.empty();
payment.empty({});
payment.register({ id: 'payment/1' });
payment.optional();
payment.optional(undefined);
payment.multiple('payment/1', 'ok');
// @ts-expect-error required object fields remain required
payment.register();
// @ts-expect-error zero-argument legacy payload must be empty
payment.empty({ reason: 'not empty' });
// @ts-expect-error optional signatures are not widened
payment.optional({});
// @ts-expect-error multiple arguments are not made optional
payment.multiple();

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type Contracts = [
  Assert<Equal<BridgeArguments<() => void>, [payload?: Record<string, never>]>>,
  Assert<Equal<BridgeArguments<(payload: { x?: number }) => void>, [payload?: { x?: number }]>>,
  Assert<Equal<BridgeArguments<(payload: { x: number }) => void>, [payload: { x: number }]>>,
  Assert<Equal<BridgeArguments<(payload?: { x: number }) => void>, [payload?: { x: number }]>>,
  Assert<Equal<BridgeArguments<(payload: unknown) => void>, [payload: unknown]>>,
  Assert<Equal<BridgeArguments<(payload: string) => void>, [payload: string]>>,
  Assert<Equal<BridgeArguments<(payload: { x?: number } | string) => void>, [payload: { x?: number } | string]>>,
  Assert<Equal<BridgeArguments<(payload: object) => void>, [payload?: object]>>,
  Assert<Equal<BridgeArguments<(x: string, y?: number) => void>, [x: string, y?: number]>>,
  Assert<Equal<BridgeArguments<(...xs: string[]) => void>, string[]>>,
];

type Correlated = [tag: 'a', payload: { a: number }] | [tag: 'b', payload: { b: string }];
declare const correlated: BridgeableAggregate<{}, {
  go: (...args: Correlated) => BridgeCommand;
  literal: (payload: { kind: 'fixed'; value: 1 }) => BridgeCommand;
}>;
export const TupleBridge = hostBridge(correlated);
const caller = new TupleBridge();
caller.go('a', { a: 1 });
caller.go('b', { b: 'ok' });
caller.literal({ kind: 'fixed', value: 1 });
// @ts-expect-error branches remain correlated
caller.go('a', { b: 'wrong branch' });
// @ts-expect-error branches remain correlated in both directions
caller.go('b', { a: 1 });
// @ts-expect-error unknown tag
caller.go('c', { a: 1 });
// @ts-expect-error absent arguments
caller.go();
// @ts-expect-error missing payload
caller.go('a');
// @ts-expect-error excess arguments
caller.go('a', { a: 1 }, 2);
// @ts-expect-error literal payloads are not widened
caller.literal({ kind: 'fixed', value: 2 });
// @ts-expect-error creators must be callable
type NonFunction = BridgeableAggregate<{}, { go: string }>;
// @ts-expect-error creators must return commands
type NonCommand = BridgeableAggregate<{}, { go: (...args: Correlated) => { payload: {} } }>;
export type CorrelatedContract = Assert<Equal<BridgeArguments<(...args: Correlated) => BridgeCommand>, Correlated>>;
