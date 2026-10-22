import { createAggregate, createAggregatePlugin, type BuiltAggregate } from '../../../src';

type Extension = { ok: true } | { payload: { bad: true } };
declare const invalid: Extension;
// @ts-expect-error A reserved key in any branch invalidates the entire initializer union.
createAggregatePlugin('explicit').commandEnvelope<Extension>(() => ({ payload: { bad: true } }));
// @ts-expect-error Inferred initializer unions cannot hide a reserved branch.
createAggregatePlugin('inferred').commandEnvelope(() => invalid);
// @ts-expect-error Explicit parser output unions cannot hide a reserved branch.
createAggregatePlugin('parsedExplicit').commandEnvelope<{}, Extension>(() => ({}), { parse: (_value: unknown) => invalid });
// @ts-expect-error Inferred parser output unions cannot hide a reserved branch.
createAggregatePlugin('parsedInferred').commandEnvelope(() => ({}), { parse: (_value: unknown) => invalid });
// @ts-expect-error Parsing cannot rescue an invalid initializer union.
createAggregatePlugin('parsedInput').commandEnvelope(() => invalid, { parse: (_value: unknown) => ({ ok: true }) });

const narrow = { parse: (_value: { required: string }) => ({ x: 1 }) };
// @ts-expect-error Parsers must accept unknown, not a narrower unrelated input.
createAggregatePlugin('narrowCommand').commandEnvelope(() => ({ x: 1 }), narrow);
// @ts-expect-error Event parsers also must accept unknown.
createAggregatePlugin('narrowEvent').eventEnvelope(() => ({ x: 1 }), narrow);
const parser = { x: 1, parse(_value: unknown) { return { x: this.x }; } };
const plugin = createAggregatePlugin('valid').commandEnvelope(() => ({ x: 1 }), parser).build();
createAggregatePlugin('validEvent').eventEnvelope(() => ({ x: 1 }), parser);
type Valid = { mode: 'a'; a: string } | { mode: 'b'; b: number };
declare const valid: Valid;
createAggregatePlugin('validExplicit').commandEnvelope<Valid>(() => valid);
createAggregatePlugin('validInferred').commandEnvelope(() => valid);
createAggregatePlugin('validParsed').commandEnvelope<{}, Valid>(() => ({}), { parse: (_value: unknown) => valid });
createAggregatePlugin('validParsedInferred').commandEnvelope(() => ({}), { parse: (_value: unknown) => valid });

type RawInput = { type: 'a'; payload: { a: string }; undeclared: boolean }
  | { type: 'b'; payload: { b: number }; undeclared: boolean };
declare const raw: RawInput;
const source = createAggregate('commandContracts', {}).build();
declare const generic: BuiltAggregate<{}>;
for (const prepared of [source.prepareCommand({}, raw), generic.prepareCommand({}, raw),
  source.withPlugins(plugin).prepareCommand({}, raw),
  source.withPlugins(plugin).withPlugins().prepareCommand({}, raw),
  createAggregate('configuredCommand', {}).plugins(plugin).build().prepareCommand({}, raw)]) {
  if (prepared.type === 'a') {
    const a: string = prepared.payload.a;
    // @ts-expect-error The other discriminant's payload is excluded.
    prepared.payload.b;
    void a;
  } else {
    const b: number = prepared.payload.b;
    // @ts-expect-error The other discriminant's payload is excluded.
    prepared.payload.a;
    void b;
  }
  // @ts-expect-error Canonical projection does not promise arbitrary raw extras.
  prepared.undeclared;
  const route: string | undefined = prepared.aggregateId;
  void route;
}
const decorated = source.withPlugins(plugin).prepareCommand({}, raw);
const x: number = decorated.x;
type Expected = ({ type: 'a'; payload: { a: string } } | { type: 'b'; payload: { b: number } }) & { x: number };
const correlated: Expected = decorated;
void [x, correlated];
