import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createAggregate } from '../../aggregate/src/index.ts';
import { createDemeineBridge } from '../src/createDemeineBridge.ts';

const Counter = createDemeineBridge(createAggregate('counter', {}).build());
const aggregate = new Counter({ sink: async (_command, instance) => instance });
let release;
const first = aggregate._sink(new Promise(resolve => { release = resolve; }));
const failure = new Error('queued command rejected before its turn');
const rejected = aggregate._sink(Promise.reject(failure)).then(
  () => assert.fail('rejected command accepted'),
  error => assert.equal(error, failure),
);
await setTimeout(20);
release({ id: 'first', type: 'counter.command', aggregateId: aggregate.id, payload: {} });
assert.equal(await first, aggregate);
await rejected;
await aggregate.getUncommittedEventsAsync();
console.log('queued rejection observed without early consumption');
