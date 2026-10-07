import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import legacy from 'demeine';
import { createAggregate } from '../../aggregate/src/index.ts';
import { createDemeineBridge } from '../src/createDemeineBridge.ts';

const [boundary, failure] = process.argv.slice(2);
let observations = 0;
function unsupportedResult() {
  const error = new Error('started asynchronous failure');
  if (failure === 'promise') return Promise.reject(error);
  // biome-ignore lint/suspicious/noThenProperty: Exercise throwing then accessors under strict unhandled-rejection mode.
  if (failure === 'getter') return { get then() { observations++; throw error; } };
  const then = (_resolve, reject) => {
    observations++;
    if (failure === 'throw') throw error;
    if (failure === 'delayed') return setImmediate(() => reject(error));
    reject(error);
  };
  return failure === 'callable' ? Object.assign(() => {}, { then }) : { then };
}

const calls = { process: 0, apply: 0, eventHandler: 0, envelope: 0, domain: 0 };
const built = createAggregate('counter', { count: 0 })
  .events({ added: state => { state.count++; } })
  .commands(emit => ({ add: { pack: () => ({}), handler: () => { calls.domain++; return emit.added({}); } } }))
  .build();
for (const name of ['process', 'apply']) {
  const original = built[name];
  built[name] = (...args) => { calls[name]++; return boundary === name ? unsupportedResult() : original(...args); };
}
const Bridge = createDemeineBridge(built, {
  AggregateBase: legacy.Aggregate,
  envelope(event) { calls.envelope++; return boundary === 'envelope' ? unsupportedResult() : event; },
});
const handler = boundary === 'eventHandler' ? { handle() { calls.eventHandler++; return unsupportedResult(); } } : undefined;
const aggregate = new Bridge(undefined, handler);
const label = ['process', 'apply'].includes(boundary) ? `builder.${boundary}` : boundary;
await assert.rejects(aggregate.add(), { name: 'TypeError', message: `${label} must be synchronous` });
await setTimeout(30);
assert.deepEqual(calls, {
  process: 1,
  domain: boundary === 'process' ? 0 : 1,
  envelope: boundary === 'process' ? 0 : 1,
  eventHandler: boundary === 'eventHandler' ? 1 : 0,
  apply: boundary === 'apply' ? 1 : 0,
});
assert.equal(observations, failure === 'promise' ? 0 : 1);
assert.equal(aggregate._state.count, 0);
assert.equal(aggregate.getVersion(), 0);
assert.deepEqual(await aggregate.getUncommittedEventsAsync(), []);
console.log('safe synchronous rejection', boundary, failure);
