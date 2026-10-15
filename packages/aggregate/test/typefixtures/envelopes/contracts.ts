import { z } from 'zod';
import type { AggregateEventPlugin } from '../../../src';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../../../src';

const aggregate = createAggregate('invoice', { total: 0 })
  .events({
    paid: (state, event: { payload: { amount: number } }) => {
      state.total += event.payload.amount;
    }
  })
  .commands((emit) => ({ pay: (_state, payload: { amount: number }) => emit.paid(payload) }))
  .build();
const root = createAggregatePluginFor(aggregate, 'audit').state(() => ({ count: 0 }));
const clock = () => new Date();
const command = root.commandEnvelope((input, context) => {
  const raw: unknown = input.dateTime;
  // @ts-expect-error envelope callbacks also run for descendants and raw ingress
  const amount: number = context.command.payload.amount;
  const total: number = context.state.total;
  const count: number = context.ownState.count;
  // @ts-expect-error raw extras are not assumed to be validated
  const date: Date = input.dateTime;
  // @ts-expect-error input is readonly
  input.dateTime = clock();
  // @ts-expect-error aggregate state is readonly
  context.state.total++;
  // @ts-expect-error own state is readonly
  context.ownState.count++;
  // @ts-expect-error command is readonly
  context.command.payload.amount++;
  return { dateTime: clock(), nested: { tags: [] as string[] } };
});
const plugin = command
  .prepareCommand((draft, context) => {
    // @ts-expect-error recipes also receive wildcard payloads
    context.command.payload.amount.toFixed();
    draft.dateTime = clock();
    draft.nested.tags.push('prepared');
    // @ts-expect-error recipe cannot write canonical command
    draft.payload = {};
    // @ts-expect-error only established extension fields exist
    draft.other = true;
  })
  .eventEnvelope((_, context) => {
    context.command.dateTime.getTime();
    // @ts-expect-error wildcard event preparation cannot assume the source payload
    const amount: number = context.event.payload.amount;
    // @ts-expect-error readonly Date omits mutators
    context.command.dateTime.setTime(0);
    // @ts-expect-error nested readonly context
    context.command.nested.tags.push('bad');
    return { audit: { commandDate: context.command.dateTime.getTime() } };
  })
  .prepareEvent((draft, context) => {
    // @ts-expect-error source command payload does not constrain wildcard ingress
    context.command.payload.amount.toFixed();
    // @ts-expect-error source event payload does not constrain descendant events
    context.event.payload.amount.toFixed();
    draft.audit.commandDate = context.command.dateTime.getTime();
    // @ts-expect-error no command extension copied onto event
    draft.dateTime = clock();
  })
  .events({
    paid(draft, event) {
      const amount: number = event.payload.amount;
      draft.count++;
      // @ts-expect-error persisted historical event is not automatically validated/enriched
      event.audit.commandDate;
      const historical: unknown = Reflect.get(event, 'audit');
      if (historical && typeof historical === 'object' && 'commandDate' in historical && typeof historical.commandDate === 'number') {
        const persistedDate: number = historical.commandDate;
      }
    }
  })
  .onEvent((_draft, event) => {
    // @ts-expect-error wildcard replay is not enriched merely by installation
    event.audit.commandDate;
  })
  .build();
aggregate.withPlugins(plugin);
// @ts-expect-error raw creators stay raw
aggregate.commandCreators.pay({ amount: 1 }).dateTime;
// @ts-expect-error retain actual payload
aggregate.commandCreators.pay({ amount: 'bad' });
// @ts-expect-error recipe requires initializer
root.prepareCommand(() => undefined);
// @ts-expect-error event recipe requires initializer
root.prepareEvent(() => undefined);
// @ts-expect-error duplicate command initializer
command.commandEnvelope(() => ({}));
const event = root.eventEnvelope(() => ({ audit: true }));
// @ts-expect-error duplicate event initializer
event.eventEnvelope(() => ({}));
// @ts-expect-error async initializer
root.commandEnvelope(async () => ({ dateTime: clock() }));
// @ts-expect-error async event initializer
root.eventEnvelope(async () => ({}));
// @ts-expect-error async recipe
command.prepareCommand(async () => undefined);
// @ts-expect-error async event recipe
event.prepareEvent(async () => undefined);
// @ts-expect-error replacement recipe return is forbidden
command.prepareCommand(() => ({ dateTime: clock() }));
// @ts-expect-error reserved canonical key
root.commandEnvelope(() => ({ payload: {} }));
// @ts-expect-error reserved event key
root.eventEnvelope(() => ({ metadata: {} }));
// @ts-expect-error parser output cannot establish reserved fields
root.commandEnvelope(() => ({}), { parse: (_: unknown) => ({ id: 'bad' }) });
// @ts-expect-error async parser
root.commandEnvelope(() => ({}), { parse: async (_: unknown) => ({ valid: true }) });

const schema = z.object({ dateTime: z.date(), nested: z.object({ count: z.number() }) });
root
  .commandEnvelope(() => ({ dateTime: clock(), nested: { count: 0 } }), { parse: (input: unknown) => schema.parse(input) })
  .prepareCommand((draft) => {
    draft.dateTime.getTime();
    draft.nested.count++;
    // @ts-expect-error parser output must not widen to object or unknown
    draft.dateTime = 'bad';
  });
root
  .eventEnvelope(() => ({ encoded: 'input' }), { parse: (_: unknown) => ({ parsed: 123 }) })
  .prepareEvent((draft) => {
    draft.parsed++;
    // @ts-expect-error initializer output is not parser output
    draft.encoded;
  });
const erased: AggregateEventPlugin<string, object> = createAggregatePlugin('empty')
  .state(() => ({}))
  .build();
type ErasedDraft = Parameters<NonNullable<typeof erased.commandEnvelope>['recipes'][number]>[0];
const erasedDraft = {} as ErasedDraft;
// @ts-expect-error erased/default extensions do not guarantee a Date
erasedDraft.dateTime;

root
  .commandEnvelope(() => ({ local: true }), undefined)
  .prepareCommand((draft) => {
    draft.local = false;
  });
const reserved = { id: '', type: '', payload: {}, metadata: {}, headers: {}, address: {}, correlation: {} };
// @ts-expect-error all canonical envelope fields remain reserved
root.commandEnvelope(() => reserved);
// @ts-expect-error index signatures cannot promise absence of reserved fields
root.eventEnvelope(() => ({}) as Record<string, unknown>);
// @ts-expect-error typed callback must not widen the inferred extension
command.prepareCommand((draft: { different: number }) => undefined);
root
  .eventEnvelope(() => ({ audit: true }))
  .commandEnvelope(() => ({ stamp: clock() }))
  .prepareEvent((_draft, context) => {
    context.command.stamp.getTime();
  });
