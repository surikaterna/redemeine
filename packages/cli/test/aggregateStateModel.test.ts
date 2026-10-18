import * as ts from 'typescript';
import { join } from 'node:path';
import { aggregateStateModel } from '../src/extract/aggregateStateModel';

function compiler(source: string) {
    const file = join(__dirname, 'virtual-model.ts');
    const options: ts.CompilerOptions = { strict: true, types: [], target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        paths: { '@redemeine/aggregate': [join(__dirname, '../../aggregate/dist/index.d.ts')] } };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile;
    host.getSourceFile = (path, ...args) => path === file ? ts.createSourceFile(file, source, options.target!, true) : original(path, ...args);
    const program = ts.createProgram([file], options, host);
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
    const checker = program.getTypeChecker();
    const module = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    const symbol = checker.getExportsOfModule(module).find(item => item.name === 'aggregate')!;
    const type = checker.getTypeOfSymbol(symbol);
    const view = checker.getTypeOfSymbol(checker.getPropertyOfType(type, 'initialState')!);
    return { checker, type, view };
}

test.each(['string | null', 'string | undefined', 'string | null | undefined'])('canonical interface preserves model %s', state => {
    const { checker, type, view } = compiler(`import type { BuiltAggregate } from '@redemeine/aggregate';
        export declare const aggregate: BuiltAggregate<${state}>;`);
    const model = aggregateStateModel(checker, type, view)!;
    const flags = model.isUnion() ? model.types.map(part => part.flags) : [model.flags];
    expect(flags.some(flag => !!(flag & ts.TypeFlags.Null))).toBe(state.includes('null'));
    expect(flags.some(flag => !!(flag & ts.TypeFlags.Undefined))).toBe(state.includes('undefined'));
});

test('canonical builder marker does not make the model optional or erase Date capabilities', () => {
    const { checker, type, view } = compiler(`import { createAggregate } from '@redemeine/aggregate';
        export const aggregate = createAggregate('model', { at: new Date(), nullable: null as string | null,
            optional: undefined as string | undefined }).build();`);
    const model = aggregateStateModel(checker, type, view)!;
    expect(model.isUnion()).toBe(false);
    const date = checker.getTypeOfSymbol(checker.getPropertyOfType(model, 'at')!);
    expect(checker.getPropertyOfType(date, 'setTime')).toBeDefined();
    for (const name of ['nullable', 'optional']) {
        const property = checker.getTypeOfSymbol(checker.getPropertyOfType(model, name)!);
        expect(property.isUnion()).toBe(true);
    }
});

test('marker absence retains the legacy view, but a fake marker fails closed', () => {
    const legacy = compiler('export declare const aggregate: { initialState: { id: string } };');
    expect(aggregateStateModel(legacy.checker, legacy.type, legacy.view)).toBe(legacy.view);
    const fake = compiler('export declare const aggregate: { initialState: { id: string }; readonly __stateType?: { id: string } };');
    expect(() => aggregateStateModel(fake.checker, fake.type, fake.view)).toThrow(/noncanonical/);
});

test('canonical marker does not authorize a broader exposed initialState view', () => {
    const { checker, type, view } = compiler(`import { createAggregate } from '@redemeine/aggregate';
        const original = createAggregate('model', { total: 0 }).build();
        interface Broader extends Omit<typeof original, 'initialState'> { initialState: { total: number; extra?: string } }
        export const aggregate: Broader = original;`);
    expect(() => aggregateStateModel(checker, type, view)).toThrow(/incompatible schema views/);
});

test('retaining a genuine marker without its view contract fails closed', () => {
    const { checker, type, view } = compiler(`import type { BuiltAggregate } from '@redemeine/aggregate';
        export declare const aggregate: Pick<BuiltAggregate<{ at: Date }>, '__stateType' | 'initialState'>;`);
    expect(() => aggregateStateModel(checker, type, view)).toThrow(/erased canonical/);
});
