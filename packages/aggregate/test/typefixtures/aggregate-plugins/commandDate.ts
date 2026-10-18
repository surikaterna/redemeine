import { createAggregate, createAggregatePluginFor } from '../../../src';
import { createMirage } from '../../../../mirage/src';

const template: { date: Date; nested: { date: Date }; dates: Date[]; optional?: Date; nullable: Date | null } = {
  date: new Date(123), nested: { date: new Date(123) }, dates: [new Date(123)],
  optional: new Date(123), nullable: new Date(123)
};
const source = createAggregate('dated', template).events({ read() {} }).commands(emit => ({ read(state) {
  state.date.getTime();
  state.date.toISOString();
  state.nested.date.toJSON();
  state.dates.map(date => date.toISOString());
  state.optional?.getTime();
  state.nullable?.toISOString();
  // @ts-expect-error command Dates have no setters
  state.date.setTime(0);
  // @ts-expect-error nested optional Dates have no setters
  state.optional?.setUTCFullYear(2000);
  // @ts-expect-error command arrays remain readonly
  state.dates.push(new Date());
  return emit.read();
} })).build();
source.process(source.initialState, source.commandCreators.read());
const host = source.withPlugins(createAggregatePluginFor(source, 'audit').state(() => ({})).build());
host.process(host.initialState, host.commandCreators.read());
createMirage(source, 'plain').read();
createMirage(host, 'mounted').read();
