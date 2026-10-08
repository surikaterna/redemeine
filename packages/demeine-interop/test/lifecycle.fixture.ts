import { Aggregate } from 'demeine';
import { createDemeineBridge, type CompatibleAggregateConstructor, type Event } from '../src';
import { definition } from './fixture';

export type State = { count: number; items: string[] };
export const implementations: [string, CompatibleAggregateConstructor<State>][] = [
  ['demeine 1.3.0', Aggregate<State>],
  ['standalone', createDemeineBridge(definition())],
];
export const event = (id: string): Event => ({ type: 'counter.added.event', aggregateId: id, payload: { amount: 1 } });
export const command = (id: string) => ({ id: 'command', type: 'counter.add.command', aggregateId: id, payload: { amount: 1 } });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
