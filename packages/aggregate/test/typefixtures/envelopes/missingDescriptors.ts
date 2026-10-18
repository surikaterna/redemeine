import { createAggregate, createAggregatePlugin } from '../../../src';

const state = createAggregatePlugin('state').state(() => ({ count: 0 })).build();
const command = createAggregatePlugin('command').state(() => ({}))
  .commandEnvelope(() => ({ commandDate: new Date() })).build();
const event = createAggregatePlugin('event').state(() => ({}))
  .eventEnvelope(() => ({ eventDate: new Date() })).build();
const base = createAggregate('host', {}).build();
const raw = { type: 'host.add.command' as const, payload: { amount: 1 }, arbitrary: true };

const stateHosts = [base.withPlugins(state), createAggregate('stateHost', {}).plugins(state).build()];
for (const host of stateHosts) {
  const prepared = host.prepareCommand(host.initialState, raw);
  const amount: number = prepared.payload.amount;
  const type: 'host.add.command' = prepared.type;
  const payload: unknown = host.process(host.initialState, raw)[0]!.payload;
  // @ts-expect-error no descriptor supplies a command extension
  prepared.commandDate;
  // @ts-expect-error canonical output does not preserve arbitrary input fields
  prepared.arbitrary;
  void [amount, type, payload];
}

const stateArray = [state];
const stateArrayHosts = [base.withPlugins(...stateArray), createAggregate('stateArrayHost', {}).plugins(...stateArray).build()];
for (const host of stateArrayHosts) {
  const amount: number = host.prepareCommand(host.initialState, raw).payload.amount;
  const payload: unknown = host.process(host.initialState, raw)[0]!.payload;
  void [amount, payload];
}
const emptyHosts = [base.withPlugins(), createAggregate('emptyHost', {}).plugins().build()];
for (const host of emptyHosts) {
  const amount: number = host.prepareCommand(host.initialState, raw).payload.amount;
  const payload: unknown = host.process(host.initialState, raw)[0]!.payload;
  void [amount, payload];
}

const commandHosts = [base.withPlugins(command), createAggregate('commandHost', {}).plugins(command).build()];
for (const host of commandHosts) {
  const prepared = host.prepareCommand(host.initialState, raw);
  const amount: number = prepared.payload.amount;
  const date: Date = prepared.commandDate;
  const payload: unknown = host.process(host.initialState, raw)[0]!.payload;
  void [amount, date, payload];
}

const eventHosts = [base.withPlugins(event), createAggregate('eventHost', {}).plugins(event).build()];
for (const host of eventHosts) {
  const prepared = host.prepareCommand(host.initialState, raw);
  const amount: number = prepared.payload.amount;
  const date: Date = host.process(host.initialState, raw)[0]!.eventDate;
  void [amount, date];
}

const mixed = [state, command, event] as const;
const tupleHosts = [base.withPlugins(...mixed), createAggregate('tupleHost', {}).plugins(...mixed).build()];
for (const host of tupleHosts) {
  const prepared = host.prepareCommand(host.initialState, raw);
  const amount: number = prepared.payload.amount;
  const type: 'host.add.command' = prepared.type;
  const commandDate: Date = prepared.commandDate;
  const eventDate: Date = host.process(host.initialState, raw)[0]!.eventDate;
  void [amount, type, commandDate, eventDate];
}

const ordinary = [state, command, event];
const arrayHosts = [base.withPlugins(...ordinary), createAggregate('arrayHost', {}).plugins(...ordinary).build()];
for (const host of arrayHosts) {
  const prepared = host.prepareCommand(host.initialState, raw);
  const amount: number = prepared.payload.amount;
  const type: 'host.add.command' = prepared.type;
  const commandDate: Date | undefined = prepared.commandDate;
  const eventDate: Date | undefined = host.process(host.initialState, raw)[0]!.eventDate;
  // @ts-expect-error an ordinary array does not guarantee a command descriptor
  const requiredCommand: Date = prepared.commandDate;
  // @ts-expect-error an ordinary array does not guarantee an event descriptor
  const requiredEvent: Date = host.process(host.initialState, raw)[0]!.eventDate;
  void [amount, type, commandDate, eventDate, requiredCommand, requiredEvent];
}

const undefinedDescriptors = { ...state, commandEnvelope: undefined, eventEnvelope: undefined };
const optionalDescriptors: Omit<typeof command, 'commandEnvelope' | 'eventEnvelope'> & {
  commandEnvelope?: typeof command.commandEnvelope | undefined;
  eventEnvelope?: typeof event.eventEnvelope | undefined;
} = { ...command, commandEnvelope: undefined, eventEnvelope: undefined };
const undefinedHosts = [base.withPlugins(undefinedDescriptors),
  createAggregate('undefinedHost', {}).plugins(undefinedDescriptors).build()];
for (const host of undefinedHosts) {
  const amount: number = host.prepareCommand(host.initialState, raw).payload.amount;
  const payload: unknown = host.process(host.initialState, raw)[0]!.payload;
  void [amount, payload];
}
const optionalHosts = [base.withPlugins(optionalDescriptors),
  createAggregate('optionalHost', {}).plugins(optionalDescriptors).build()];
for (const host of optionalHosts) {
  const prepared = host.prepareCommand(host.initialState, raw);
  const amount: number = prepared.payload.amount;
  const commandDate: Date | undefined = prepared.commandDate;
  const eventDate: Date | undefined = host.process(host.initialState, raw)[0]!.eventDate;
  // @ts-expect-error explicitly undefined optional descriptors do not prove presence
  const requiredCommand: Date = prepared.commandDate;
  // @ts-expect-error explicitly undefined optional descriptors do not prove presence
  const requiredEvent: Date = host.process(host.initialState, raw)[0]!.eventDate;
  void [amount, commandDate, eventDate, requiredCommand, requiredEvent];
}
