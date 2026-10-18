import { produce } from 'immer';
import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePluginFor, type AggregateStateModel, type AggregateStateView } from '../../../src';

type Model = {
  readonly nested?: { readonly items: readonly string[]; readonly date: Date } | null;
  readonly tuple: readonly [number, { label: string }?];
  callback: (value: number) => string;
};
const template: Model = { nested: { items: [], date: new Date() }, tuple: [1], callback: String };
const builder = createAggregate('views', template).events({
  changed(draft, event: Event<string>) {
    draft.nested?.items.push(event.payload);
    draft.nested?.date.setFullYear(2026);
    draft.tuple[0]++;
  }
}).commands(emit => ({ change(state, value: string) {
  state.nested?.date.toISOString();
  state.callback(1);
  // @ts-expect-error commands cannot mutate arrays
  state.nested?.items.push(value);
  // @ts-expect-error commands cannot mutate Dates
  state.nested?.date.setTime(0);
  return emit.changed(value);
} })).selectors({ size: state => state.nested?.items.length ?? 0 });
const source = builder.build();
const plugin = createAggregatePluginFor(source, 'audit').state<Model>(() => ({ ...template }))
  .events({ changed(draft, event) {
    draft.nested?.items.push(event.payload);
    draft.nested?.date.setTime(1);
  } }).build();
const host = source.withPlugins(plugin);
// @ts-expect-error initialState cannot be reassigned
host.initialState = { ...source.initialState, audit: template };
// @ts-expect-error optional nested arrays remain readonly
host.initialState.nested?.items.push('no');
// @ts-expect-error Dates expose readers, not setters
host.initialState.audit.nested?.date.setUTCFullYear(2000);
// @ts-expect-error tuples remain readonly
host.initialState.tuple[0] = 2;
host.initialState.nested?.date.toISOString();
host.initialState.callback(2);
const command = host.prepareCommand(host.initialState, host.commandCreators.change('ok'));
const events = host.process(host.initialState, command);
let state = host.initialState;
for (const event of events) state = host.apply(state, event);
state = host.apply(state, events[0]!);
host.selectors.size(state);
// Model extraction must retain Date setters for drafts across repeated decoration.
const chained = host.withPlugins(createAggregatePluginFor(host, 'next').state(() => ({ count: 0 })).build());
produce<AggregateStateModel<typeof chained>>(templateWithPlugins(), draft => chained.applyToDraft(draft, events[0]!));
function templateWithPlugins(): AggregateStateModel<typeof chained> {
  return { ...template, audit: template, next: { count: 0 } };
}
declare const collections: AggregateStateView<{ map: Map<string, { count: number }>; set: Set<string> }>;
collections.map.get('key')?.count;
// @ts-expect-error maps expose readonly operations
collections.map.set('key', { count: 1 });
// @ts-expect-error sets expose readonly operations
collections.set.add('key');
