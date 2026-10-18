import { createAggregate } from '../../../src';

const source = createAggregate('collections', Object.freeze({
  map: new Map([['key', 123]]), set: new Set([123])
})).events({ read() {} }).commands(emit => ({ read(state) {
  if (state.map.get('key') !== 123) throw new Error('Map.get');
  if (!state.map.has('key')) throw new Error('Map.has');
  if ([...state.map.entries()][0]?.[1] !== 123) throw new Error('Map.entries');
  if (!state.set.has(123)) throw new Error('Set.has');
  if ([...state.set][0] !== 123) throw new Error('Set.iterator');
  return emit.read();
} })).build();
source.process(source.initialState, source.commandCreators.read());
