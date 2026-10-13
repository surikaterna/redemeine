import { createDemeineBridge } from '@redemeine/demeine-interop';

const Counter = createDemeineBridge({
  initialState: { count: 0 }, aggregateType: 'counter',
  types: { commands: { add: 'counter.add.command' }, events: { added: 'counter.added.event' } },
  commandCreators: { add: amount => ({ id: 'command', type: 'counter.add.command', payload: { amount } }) },
  process: (_state, command) => [{ id: 'event', type: 'counter.added.event', payload: command.payload }],
  apply: (state, event) => ({ count: state.count + event.payload.amount }),
});
globalThis.browserSmoke = (async () => {
  const aggregate = new Counter();
  let emitted = false;
  aggregate._commandQueue.once('probe', () => { emitted = true; });
  aggregate._commandQueue.emit('probe');
  await aggregate.add(2);
  const pending = await aggregate.getUncommittedEventsAsync();
  if (!emitted || aggregate._state.count !== 2 || aggregate.getVersion() !== 1 || pending.length !== 1) {
    throw new Error('Standalone browser lifecycle failed');
  }
  return { count: aggregate._state.count, version: aggregate.getVersion() };
})();
