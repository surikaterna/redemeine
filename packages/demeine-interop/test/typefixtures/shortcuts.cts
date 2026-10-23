import { createDemeineBridge, type BridgeableAggregate, type BridgeCommand } from '@redemeine/demeine-interop';

declare const definition: BridgeableAggregate<{}, {
  go: (...args: ['a', { a: number }] | ['b', { b: string }]) => BridgeCommand;
}>;
const caller = new (createDemeineBridge(definition))();
caller.go('a', { a: 1 });
caller.go('b', { b: 'ok' });
// @ts-expect-error CJS callers also retain correlation
caller.go('a', { b: 'wrong branch' });
