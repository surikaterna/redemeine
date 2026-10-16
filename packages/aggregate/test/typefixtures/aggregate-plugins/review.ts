import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePluginFor } from '../../../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function expectTrue<T extends true>(_value: T): undefined {}

const source = createAggregate('nullable', { nested: { date: null as Date | null } }).events({
  nil(_state, _event: Event<null>) {},
  absent(_state, _event: Event<undefined>) {},
  nothing(_state, _event: Event<void>) {},
  changed(_state, _event: Event<{ date: Date; value: number } | null | undefined>) {}
}).build();
createAggregatePluginFor(source, 'readable').state(() => ({})).events({
  nil(_draft, event) { expectTrue<Equal<typeof event.payload, null>>(true); },
  absent(_draft, event) { expectTrue<Equal<typeof event.payload, undefined>>(true); },
  nothing(_draft, event) { expectTrue<Equal<typeof event.payload, void>>(true); },
  changed(_draft, event, context) {
    expectTrue<Equal<typeof event.payload, { readonly date: Readonly<Omit<Date, `set${string}`>>; readonly value: number } | null | undefined>>(true);
    // @ts-expect-error nullable payload requires narrowing
    event.payload.value;
    if (event.payload) {
      const time: number = event.payload.date.getTime();
      const iso: string = event.payload.date.toISOString();
      // @ts-expect-error Date mutators are not exposed
      event.payload.date.setTime(0);
      // @ts-expect-error readonly payload property
      event.payload.value++;
      void [time, iso];
    }
    if (context.state.nested.date) {
      context.state.nested.date.getTime();
      context.state.nested.date.toISOString();
      // @ts-expect-error nested nullable context Date mutators are not exposed
      context.state.nested.date.setUTCFullYear(2000);
    }
  }
});
