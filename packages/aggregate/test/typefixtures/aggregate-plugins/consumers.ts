import { createAggregate, createAggregatePluginFor, type AggregateStateModel } from '../../../src';
import { createProjection, type AggregateStateOf } from '../../../../projection/src';
import { createMirage, extractState, subscribe, type BuiltAggregateState } from '../../../../mirage/src';
import type { Event } from '@redemeine/kernel';

type Model = { date: Date; nested: { date: Date }; dates: Date[]; labels: string[] };
const model: Model = { date: new Date(), nested: { date: new Date() }, dates: [new Date()], labels: [] };
const source = createAggregate('consumer', model).events({ changed(draft, event: Event<string>) {
  draft.labels.push(event.payload);
  draft.dates[0]?.setTime(1);
} }).commands(emit => ({ change: (_state, label: string) => emit.changed(label) }))
  .selectors({ labelCount: state => state.labels.length }).build();
const audit = createAggregatePluginFor(source, 'audit').state(() => ({ count: 0 })).events({
  changed(draft, _event, context) {
    context.state.dates[0]?.toISOString();
    // @ts-expect-error callback state arrays are readonly
    context.state.labels.push('no');
    // @ts-expect-error callback Dates have no setters
    context.state.dates[0]?.setTime(2);
    draft.count++;
  }
}).build();
const host = source.withPlugins(audit);
const projection = createProjection('mirror').mirror(host, { changed(state, event) {
  state.labels.push(event.payload);
  state.dates[0]?.setTime(3);
  state.audit.count++;
} }).build();
const projectionModel: AggregateStateOf<typeof host> = { ...model, audit: { count: 0 } };
projectionModel.dates.push(new Date());
const mirageModel: BuiltAggregateState<typeof host> = projectionModel;
mirageModel.dates[0]?.setTime(4);
const retained: AggregateStateModel<typeof host> = mirageModel;
const live = createMirage(host, 'one', { snapshot: host.initialState });
createMirage(host, 'two', { snapshot: retained });
live.dates[0]?.toISOString();
live.date.toISOString();
live.nested.date.getTime();
// @ts-expect-error directly exposed Dates have no setters
live.date.setTime(0);
// @ts-expect-error nested exposed Dates have no setters
live.nested.date.setUTCFullYear(2000);
live.labelCount();
extractState(live).dates[0]?.getTime();
subscribe(live, state => {
  state.dates[0]?.toISOString();
  // @ts-expect-error subscribe does not hand out mutable models
  state.dates[0]?.setTime(0);
});
// @ts-expect-error public arrays remain readonly
live.labels.push('no');
// @ts-expect-error public Dates do not claim writable Date methods
live.dates[0]?.setTime(0);
async function commandResult() {
  const state = await live.change('yes');
  state.dates[0]?.toISOString();
  // @ts-expect-error command result arrays remain readonly
  state.labels.push('no');
}
const fallbackProjection: AggregateStateOf<{ initialState: Model }> = model;
const fallbackMirage: BuiltAggregateState<{ initialState: Model }> = model;
fallbackProjection.dates[0]?.setTime(5);
fallbackMirage.labels.push('ok');
void [projection, commandResult];
