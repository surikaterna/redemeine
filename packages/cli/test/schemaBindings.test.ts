import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ts from 'typescript';
import { z } from 'zod';
import { extractZodSchemas } from '../src/extractZodSchemas';
import { schemaBindings } from '../../aggregate/src';
import { aggregate } from './fixtures/schemaBindings';

test('generated Zod/JSON schema IDs join compiled wires and validate packed payloads, not arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schema-bindings-'));
    try {
        const entry = join(__dirname, 'fixtures/schemaBindings.ts');
        const config = join(directory, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022',
            module: 'ESNext', moduleResolution: 'Bundler', types: [] }, files: [entry] }));
        const outFile = join(directory, 'schemas.ts');
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile });
        const js = ts.transpileModule(readFileSync(outFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
        const schemas: { commandSchemas: Record<string, z.ZodType>; eventSchemas: Record<string, z.ZodType> } = {} as never;
        new Function('require', 'exports', js)(() => ({ z }), schemas);
        extractZodSchemas({ entry, tsconfig: config, aggregateExport: 'aggregate', outFile, format: 'json-schema' });
        const json = JSON.parse(readFileSync(outFile, 'utf8'));
        const bindings = schemaBindings(aggregate);
        for (const [kind, generated, raw] of [
            [bindings.commands, schemas.commandSchemas, json.commands], [bindings.events, schemas.eventSchemas, json.events],
        ] as const) {
            expect(Object.keys(kind.schemaToWire).sort()).toEqual(Object.keys(generated).sort());
            for (const id of Object.values(kind.wireToSchema)) {
                if (!generated[id] || !Object.hasOwn(raw, id)) throw Error(`Missing generated schema: ${id}`);
            }
        }
        const command = aggregate.commandCreators.create('42');
        expect(command.type).toBe(bindings.commands.schemaToWire.create.wireType);
        expect(schemas.commandSchemas.create.safeParse(command.payload).success).toBe(true);
        expect(schemas.commandSchemas.create.safeParse(['42']).success).toBe(false);
        const mounted = aggregate.commandCreators.itemsRegister(' valid ');
        const event = aggregate.process({ count: 0, items: { one: { key: 'one', label: '' } } }, mounted)[0]!;
        const winner = bindings.events.wireToSchema[event.type];
        expect(winner).toBe('items.registered');
        expect(schemas.eventSchemas[winner].safeParse(event.payload).success).toBe(true);
        expect(schemas.eventSchemas[winner].safeParse({ count: 1 }).success).toBe(false);
        expect(bindings.events.schemaToWire.changed.isWireWinner).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
