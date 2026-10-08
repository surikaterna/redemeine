import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import Bluebird from 'bluebird';
import { createAggregate } from '../../aggregate/src/index.ts';
import { createDemeineBridge } from '../src/createDemeineBridge.ts';

const [kind = 'native', timing = 'immediate'] = process.argv.slice(2);
const failure = kind === 'realm' ? runInNewContext('new Error("foreign rejection")') : new Error('queued rejection');
const unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(reason));
let reads = 0;
let assimilations = 0;
function rejectingInput() {
  const fail = reject => timing === 'delayed' ? setTimeout(() => reject(failure), 5) : reject(failure);
  if (kind === 'native') return new Promise((_resolve, reject) => fail(reject));
  if (kind === 'bluebird') return new Bluebird((_resolve, reject) => fail(reject));
  if (kind === 'realm') return runInNewContext('new Promise((_resolve, reject) => fail(reject))', { fail });
  return {
    // biome-ignore lint/suspicious/noThenProperty: Exercise one-time thenable adoption and throwing getters.
    get then() {
      reads++;
      if (kind === 'getter') throw failure;
      return (_resolve, reject) => {
        assimilations++;
        if (kind === 'throwing-then') throw failure;
        fail(reject);
      };
    },
  };
}
const Counter = createDemeineBridge(createAggregate('counter', {}).build());
let release;
const gate = new Promise(resolve => { release = resolve; });
const calls = [];
const aggregate = new Counter({ sink(command, instance) {
  calls.push(command);
  return calls.length === 1 ? gate : Promise.resolve(instance);
} }, null, { handle() { assert.fail('sink rejection must not fall back to processing'); } });
const firstCommand = { id: 'first', type: 'counter.command', aggregateId: aggregate.id, payload: {} };
const first = aggregate._sink(firstCommand);
await delay(0);
assert.deepEqual(calls, [firstCommand]);
let second;
assert.doesNotThrow(() => { second = aggregate._sink(rejectingInput()); });
let delivered = false;
const rejected = second.then(
  () => assert.fail('rejected command accepted'),
  error => { assert.equal(error, failure); delivered = true; },
);
const laterCommand = { type: 'counter.command', payload: {} };
const later = aggregate._sink(laterCommand);
await delay(20);
assert.equal(delivered, false);
assert.deepEqual(calls, [firstCommand]);
assert.equal(Object.hasOwn(laterCommand, 'id'), false);
assert.equal(Object.hasOwn(laterCommand, 'aggregateType'), false);
aggregate.id = 'late-id';
aggregate.type = 'LateType';
laterCommand.aggregateId = aggregate.id;
const warnings = [];
const warn = console.warn;
console.warn = message => warnings.push(message);
release(aggregate);
assert.equal(await first, aggregate);
await rejected;
assert.equal(await later, aggregate);
await aggregate.getUncommittedEventsAsync();
console.warn = warn;
await delay(20);
assert.deepEqual(unhandled, []);
assert.deepEqual(calls, [firstCommand, laterCommand]);
assert.equal(laterCommand.aggregateType, 'LateType');
assert.match(laterCommand.id, /^[a-f0-9-]{36}$/);
assert.equal(warnings.length, 1);
assert.equal(aggregate.getVersion(), 0);
assert.equal(aggregate.getUncommittedEvents().length, 0);
if (['getter', 'thenable', 'throwing-then'].includes(kind)) assert.equal(reads, 1);
if (['thenable', 'throwing-then'].includes(kind)) assert.equal(assimilations, 1);
console.log('queued rejection observed without early consumption', kind, timing);
