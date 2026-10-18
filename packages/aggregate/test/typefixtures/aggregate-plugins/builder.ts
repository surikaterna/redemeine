import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../../../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function expectTrue<T extends true>(_value: T): undefined {}

const source = createAggregate('account', { balance: 0, nested: { active: true } })
  .events({ credited(state, event: Event<{ amount: number }>) { state.balance += event.payload.amount; } })
  .build();

const plugin = createAggregatePluginFor(source, 'totals').state(() => ({ nested: { sum: 0 }, rows: [] as number[] }))
  .events({
    credited(draft, event, context) {
      draft.nested.sum += event.payload.amount;
      draft.rows.push(event.payload.amount);
      const name: string = context.aggregateType;
      const balance: number = context.state.balance;
      const type: string = event.type;
      void [name, balance, type];
      // @ts-expect-error readonly aggregate state
      context.state.nested.active = false;
      // @ts-expect-error wrong payload property
      event.payload.missing;
      // @ts-expect-error readonly event payload
      event.payload.amount = 1;
      // @ts-expect-error no fabricated principal
      context.principal;
      // @ts-expect-error no fabricated principal on event
      event.principal;
    }
  }).onEvent((draft, event, context) => {
    expectTrue<Equal<typeof event.payload, unknown>>(true);
    draft.nested.sum += context.state.balance;
    // @ts-expect-error catchall includes unknown runtime payloads
    event.payload.amount;
  }).build();
const sourceIdentity: typeof source = plugin.source;
void sourceIdentity;

createAggregatePluginFor(source, 'partial').state(() => ({})).events({});
createAggregatePluginFor(source, 'bad-key').state(() => ({})).events({
  // @ts-expect-error only declared projector keys
  missing() {}
});
createAggregatePluginFor(source, 'bad-payload').state(() => ({})).events({
  // @ts-expect-error mismatched payload
  credited(_draft, _event: Event<{ amount: string }>) {}
});
createAggregatePlugin('generic').state(() => ({ count: 0 })).events({
  anything(draft, event, context) {
    expectTrue<Equal<typeof event.payload, unknown>>(true);
    draft.count++;
    // @ts-expect-error generic payload is unknown
    event.payload.amount;
    // @ts-expect-error generic aggregate state is unknown
    context.state.balance;
  }
});
// @ts-expect-error state must precede handlers
createAggregatePlugin('early').onEvent(() => {});
// @ts-expect-error state must be an object
createAggregatePlugin('primitive').state(() => 1);
// @ts-expect-error async initializer
createAggregatePlugin('async-state').state(async () => ({}));
// @ts-expect-error async catchall
createAggregatePlugin('async-handler').state(() => ({})).onEvent(async () => {});
createAggregatePluginFor(source, 'async-event').state(() => ({})).events({
  // @ts-expect-error async matched handler
  credited: async () => {}
});
const voidCallback: () => void = () => {};
const widenedInitializer: () => object = () => Promise.reject(new Error('refused at invocation'));
createAggregatePlugin('widened-initializer').state(widenedInitializer);
// @ts-expect-error void callback may hide a Promise
createAggregatePlugin('void-handler').state(() => ({})).onEvent(voidCallback);
// @ts-expect-error callbacks may not return values
createAggregatePlugin('value-handler').state(() => ({})).onEvent(() => 1);
const widened: string = 'wide';
// @ts-expect-error widened id
createAggregatePlugin(widened);
const union: 'one' | 'two' = Math.random() ? 'one' : 'two';
// @ts-expect-error union id
createAggregatePluginFor(source, union);
// @ts-expect-error empty id
createAggregatePlugin('');
// @ts-expect-error reserved id
createAggregatePlugin('__proto__');
// @ts-expect-error reserved id
createAggregatePlugin('constructor');
// @ts-expect-error reserved id
createAggregatePlugin('toString');
// @ts-expect-error reserved legacy prototype name
createAggregatePlugin('__defineGetter__');
// @ts-expect-error immutable descriptor
plugin.id = 'other';

const explicit = {
  aggregateType: 'custom' as const, initialState: { count: 0 },
  pure: { eventProjectors: { changed(_state: object, _event: Event<{ value: number }>) {} } },
  types: { events: { changed: 'external.change.event' as const } }
};
createAggregatePluginFor(explicit, 'resolved').state(() => ({})).events({
  changed(_draft, event) { const type: 'external.change.event' = event.type; void type; }
});
const fallback = { aggregateType: 'custom' as const, initialState: {}, pure: explicit.pure };
createAggregatePluginFor(fallback, 'fallback').state(() => ({})).events({
  changed(_draft, event) { const type: 'changed' | 'custom.changed.event' = event.type; void type; }
});

const readonlyInitial: { readonly nested: { readonly count: number }; readonly rows: readonly number[] } = { nested: { count: 0 }, rows: [] };
createAggregatePlugin('nested-draft').state(() => readonlyInitial).onEvent(draft => {
  draft.nested.count++;
  draft.rows.push(1);
});

type OptionalData = { maybe?: { count: number }; nullable: { count: number } | null };
const optionalSource = createAggregate('optional', {} as OptionalData)
  .events({ changed(_state, _event: Event<OptionalData>) {} }).build();
createAggregatePluginFor(optionalSource, 'readonly-unions').state(() => readonlyInitial).events({
  changed(draft, event, context) {
    draft.nested.count++;
    draft.rows.push(1);
    if (context.state.maybe) {
      // @ts-expect-error optional source object is deeply readonly
      context.state.maybe.count++;
    }
    if (context.state.nullable) {
      // @ts-expect-error nullable source object is deeply readonly
      context.state.nullable.count++;
    }
    if (event.payload.maybe) {
      // @ts-expect-error optional payload object is deeply readonly
      event.payload.maybe.count++;
    }
    if (event.payload.nullable) {
      // @ts-expect-error nullable payload object is deeply readonly
      event.payload.nullable.count++;
    }
    if (event.metadata) {
      // @ts-expect-error optional metadata is deeply readonly
      event.metadata.key = 'mutated';
    }
    if (event.headers) {
      // @ts-expect-error optional headers are deeply readonly
      event.headers.key = 'mutated';
    }
  }
}).onEvent((draft, event, context) => {
  draft.nested.count++;
  if (context.state.maybe) {
    // @ts-expect-error catchall optional source object is deeply readonly
    context.state.maybe.count++;
  }
  if (context.state.nullable) {
    // @ts-expect-error catchall nullable source object is deeply readonly
    context.state.nullable.count++;
  }
  if (event.metadata) {
    // @ts-expect-error catchall metadata is deeply readonly
    event.metadata.key = 'mutated';
  }
  if (event.headers) {
    // @ts-expect-error catchall headers are deeply readonly
    event.headers.key = 'mutated';
  }
});
