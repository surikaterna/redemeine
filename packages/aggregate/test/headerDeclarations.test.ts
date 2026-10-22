import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { createAggregate, createAggregatePlugin, type AggregateEventPlugin } from '../src';

const reservedKeys = ['id', 'type', 'payload', 'metadata', 'headers', 'aggregateId', 'aggregateType',
  'correlationId', 'causationId', 'address', 'correlation', 'constructor', 'toString', 'toLocaleString',
  'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__proto__', 'prototype', 'then'];

const optionalHosts = [
  'base.withPlugins(...list)', 'root.plugins(...list).build()',
  'base.withPlugins(...list).withPlugins(...empty)', 'root.plugins(...list).plugins(...empty).build()',
  "createAggregate('inherited', {}).extends(root.plugins(...list)).plugins(...empty).build()",
  'base.withPlugins(optionalA, optionalB)', 'base.withPlugins(optionalB, optionalA)',
  'root.plugins(optionalA, optionalB).build()', 'root.plugins(optionalB, optionalA).build()',
  'base.withPlugins(optionalA).withPlugins(optionalB)', 'base.withPlugins(optionalB).withPlugins(optionalA)',
  'root.plugins(optionalA).plugins(optionalB).plugins(...empty).build()',
  'base.withPlugins(a, optionalB)', 'base.withPlugins(optionalB, a)',
  'base.withPlugins(b, optionalA)', 'base.withPlugins(optionalA, b)',
  'root.plugins(a).build().withPlugins(optionalB)', 'root.plugins(optionalB).plugins(a).build()',
  'base.withPlugins(a, b)', 'base.withPlugins(b, a)',
  'root.plugins(a, b).build()', 'root.plugins(b, a).build()',
  'base.withPlugins(a).withPlugins(b)', 'base.withPlugins(b).withPlugins(a)',
  'root.plugins(a).build().withPlugins(b)', 'root.plugins(b).build().withPlugins(a)',
  'root.plugins(a).plugins(b).plugins(...empty).build()',
  "createAggregate('inherited', {}).extends(root.plugins(a)).plugins(b).build()"
];
const declarationCases = ['ts', 'mts', 'cts'].flatMap(suffix => [
  ...['headers', 'unions', 'commandContracts', 'builderHeaders', 'possibleContributions', 'optionalEdges', 'compositionSoundness'].map(fixture => [suffix, fixture, '']),
  ...optionalHosts.map(host => [suffix, 'optionalComposition', host])
]);
test.each(declarationCases)('%s declarations preserve %s %s inference and negative contracts', (suffix, fixture, hostCase) => {
  const fixturePath = join(__dirname, `typefixtures/envelopes/${fixture}.ts`);
  const entry = suffix === 'ts' ? fixturePath : join(__dirname, `typefixtures/publicHeaders.${suffix}`);
  let source = readFileSync(fixturePath, 'utf8');
  if (hostCase) source = source.replace('const host = base.withPlugins(...list);', `const host = ${hostCase};`);
  if (hostCase && !hostCase.includes('optional') && !hostCase.includes('...list')) {
    source = source.replace("type B = { mode?: 'b'; value: number };", 'type B = { value: number };');
    source += '\nconst requiredCommandValue: number = command.value; const requiredEventValue: number = event.value;';
  }
  if (fixture === 'commandContracts') {
    const reservedCases = source.slice(source.indexOf('type Extension'), source.indexOf('const narrow'));
    source += reservedKeys.filter(key => key !== 'payload').map((key, index) =>
      reservedCases.replaceAll('payload:', `${JSON.stringify(key)}:`)
        .replaceAll('Extension', `Extension${index}`).replaceAll('invalid', `invalid${index}`)).join('\n');
  }
  if (suffix !== 'ts') source = source.replace("from '../../../src'", "from '@redemeine/aggregate'");
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2022, module: suffix === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: suffix === 'ts' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext, types: []
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => file === entry ? source : readFile(file);
  host.fileExists = file => file === entry || fileExists(file);
  const program = ts.createProgram([entry], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  if (suffix !== 'ts') {
    const extension = suffix === 'mts' ? 'd.ts' : 'd.cts';
    expect(program.getSourceFiles().some(file => file.fileName.endsWith(`/aggregate/dist/index.${extension}`))).toBe(true);
  }
});

test('one array member and absent descriptors produce valid envelopes without conflicting alternatives', () => {
  const root = createAggregate('possibleRuntime', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) }));
  type Body = { mode: 'trace'; traceId: string } | { mode: 'audit'; auditId: number };
  const one = createAggregatePlugin('one').commandEnvelope<Body>(() => ({ mode: 'trace', traceId: 'one' }))
    .eventEnvelope<Body>(() => ({ mode: 'audit', auditId: 1 })).build();
  const list: (typeof one)[] = [one];
  const host = root.plugins(...list).build();
  expect(host.prepareCommand({}, host.commandCreators.go())).toMatchObject({ mode: 'trace', traceId: 'one' });
  expect(host.process({}, host.commandCreators.go())[0]).toMatchObject({ mode: 'audit', auditId: 1 });
  const absent: AggregateEventPlugin<'absentConflict', undefined, undefined, { mode: 'audit' }, { mode: 'audit' }> = {
    ...createAggregatePlugin('absentConflict').build(), commandEnvelope: undefined, eventEnvelope: undefined
  };
  const trace = createAggregatePlugin('trace').commandEnvelope(() => ({ mode: 'trace' as const }))
    .eventEnvelope(() => ({ mode: 'trace' as const, headers: { traceId: 'one' } })).build();
  const decorated = createAggregate('absentRuntime', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) }))
    .build().withPlugins(absent, trace);
  expect(decorated.prepareCommand({}, decorated.commandCreators.go())).toMatchObject({ mode: 'trace' });
  expect(decorated.process({}, decorated.commandCreators.go())[0]).toMatchObject({ mode: 'trace', headers: { traceId: 'one' } });
});

test('an absent builder descriptor preserves raw numeric event headers through attachment', () => {
  const absent: AggregateEventPlugin<'absent', undefined, undefined, {}, { headers: { traceId: string } }> = {
    ...createAggregatePlugin('absent').build(), eventEnvelope: undefined
  };
  const host = createAggregate('rawBuilder', {}).commands(() => ({
    go: () => ({ type: 'changed', payload: {}, headers: { traceId: 123 } })
  })).plugins(absent).build();
  const extra = createAggregatePlugin('extra').eventEnvelope(() => ({ observed: true })).build();
  expect(host.process({}, host.commandCreators.go())[0]!.headers?.traceId).toBe(123);
  expect(host.withPlugins(extra).process({}, host.commandCreators.go())[0]!.headers?.traceId).toBe(123);
});

test('array subsets admit disjoint writers but overlapping writers still collide', () => {
  const base = createAggregate('subsets', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) })).build();
  const a = createAggregatePlugin('a').commandEnvelope(() => ({ mode: 'a' as const }))
    .eventEnvelope(() => ({ mode: 'a' as const })).build();
  const b = createAggregatePlugin('b').commandEnvelope(() => ({ mode: 'b' as const }))
    .eventEnvelope(() => ({ mode: 'b' as const })).build();
  const extra = createAggregatePlugin('extra').commandEnvelope(() => ({ extra: 1 }))
    .eventEnvelope(() => ({ observed: true })).build();
  const alternatives: (typeof a | typeof b)[] = [a];
  const disjoint = [a, extra];
  const command = base.commandCreators.go();
  expect(base.withPlugins(...alternatives).prepareCommand({}, command)).toMatchObject({ mode: 'a' });
  expect(base.withPlugins(...alternatives).process({}, command)[0]).toMatchObject({ mode: 'a' });
  expect(base.withPlugins(...disjoint).prepareCommand({}, command)).toMatchObject({ mode: 'a', extra: 1 });
  expect(base.withPlugins(...disjoint).process({}, command)[0]).toMatchObject({ mode: 'a', observed: true });
  expect(() => base.withPlugins(a, b).prepareCommand({}, command)).toThrow('Envelope extension collision: mode');
  const eventOnly = createAggregatePlugin('eventOnly').eventEnvelope(() => ({ mode: 'b' as const })).build();
  expect(() => base.withPlugins(a, eventOnly).process({}, command)).toThrow('Envelope extension collision: mode');
});

test('optional output declarations admit actual disjoint writes, not duplicate own undefined keys', () => {
  const base = createAggregate('optionalRuntime', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) })).build();
  type A = { mode: 'a'; value?: string };
  type B = { mode?: 'b'; value: number };
  const a = createAggregatePlugin('a').commandEnvelope<A>(() => ({ mode: 'a' }))
    .eventEnvelope<A>(() => ({ mode: 'a' })).build();
  const b = createAggregatePlugin('b').commandEnvelope<B>(() => ({ value: 123 }))
    .eventEnvelope<B>(() => ({ value: 123 })).build();
  const list: (typeof a | typeof b)[] = [a, b];
  for (const host of [base.withPlugins(a, b), base.withPlugins(b, a), base.withPlugins(...list)]) {
    const command = host.prepareCommand({}, base.commandCreators.go());
    const event = host.process({}, base.commandCreators.go())[0]!;
    expect(command).toMatchObject({ mode: 'a', value: 123 });
    expect(event).toMatchObject({ mode: 'a', value: 123 });
    if (command.mode === 'a' && command.value !== undefined) {
      // @ts-expect-error The actual numeric value must never be approved as a string.
      expect(() => command.value.toUpperCase()).toThrow(TypeError);
    }
    if (event.mode === 'a' && event.value !== undefined) {
      // @ts-expect-error The event has the same successful noncolliding output.
      expect(() => event.value.toUpperCase()).toThrow(TypeError);
    }
  }
  const ownUndefined = createAggregatePlugin('ownUndefined').commandEnvelope<{ value?: undefined }>(() => ({ value: undefined })).build();
  const eventUndefined = createAggregatePlugin('eventUndefined').eventEnvelope<{ value?: undefined }>(() => ({ value: undefined })).build();
  expect(() => base.withPlugins(ownUndefined, b).prepareCommand({}, base.commandCreators.go())).toThrow('Envelope extension collision: value');
  expect(() => base.withPlugins(eventUndefined, b).process({}, base.commandCreators.go())).toThrow('Envelope extension collision: value');
});

test('identical output unions and pattern indexes admit disjoint writes while collisions still fail', () => {
  const base = createAggregate('compositionRuntime', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) })).build();
  type Body = { mode?: 'a'; value?: string } | { mode?: 'b'; value?: number };
  const a = createAggregatePlugin('a').commandEnvelope<Body>(() => ({ mode: 'a' }))
    .eventEnvelope<Body>(() => ({ mode: 'a' })).build();
  const b = createAggregatePlugin('b').commandEnvelope<Body>(() => ({ value: 123 }))
    .eventEnvelope<Body>(() => ({ value: 123 })).build();
  const list: (typeof a | typeof b)[] = [a, b];
  const pattern = createAggregatePlugin('pattern').commandEnvelope<Record<`extra_${string}`, string>>(() => ({}))
    .eventEnvelope<Record<`extra_${string}`, string>>(() => ({})).build();
  const literal = createAggregatePlugin('literal').commandEnvelope(() => ({ extra_value: 123 }))
    .eventEnvelope(() => ({ extra_value: 123 })).build();
  for (const host of [base.withPlugins(...list), base.withPlugins(pattern, literal), base.withPlugins(literal, pattern),
    base.withPlugins(pattern).withPlugins(literal)]) {
    const command = host.prepareCommand({}, base.commandCreators.go());
    const event = host.process({}, base.commandCreators.go())[0]!;
    const key = 'mode' in command ? 'value' : 'extra_value';
    expect(Reflect.get(command, key)).toBe(123);
    expect(Reflect.get(event, key)).toBe(123);
  }
  const collision = createAggregatePlugin('collision').commandEnvelope(() => ({ value: 'duplicate' }))
    .eventEnvelope(() => ({ value: 'duplicate' })).build();
  expect(() => base.withPlugins(b, collision).prepareCommand({}, base.commandCreators.go())).toThrow('Envelope extension collision: value');
  const eventCollision = createAggregatePlugin('eventCollision').eventEnvelope(() => ({ value: 'duplicate' })).build();
  expect(() => base.withPlugins(b, eventCollision).process({}, base.commandCreators.go())).toThrow('Envelope extension collision: value');
});
