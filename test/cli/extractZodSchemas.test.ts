import * as path from 'node:path';
import * as ts from 'typescript';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
    createProgramFromConfig,
    resolveAggregateType,
    extractCommandPayloads,
    extractEventPayloads,
    extractStateType
} from '../../src/cli/extract/aggregateNavigator';
import { TypeToZodConverter } from '../../src/cli/extract/typeConverter';
import { generateOutput } from '../../src/cli/extract/outputGenerator';
import { extractZodSchemas } from '../../src/cli/extractZodSchemas';

const fixturesDir = path.resolve(__dirname, 'fixtures');
const tsconfigPath = path.resolve(fixturesDir, 'tsconfig.json');
const entryPath = path.resolve(fixturesDir, 'test-aggregate.ts');

// Shared setup: create program and resolve aggregate type once
let program: ts.Program;
let checker: ts.TypeChecker;
let aggType: ts.Type;
let sourceFile: ts.SourceFile;

beforeAll(() => {
    program = createProgramFromConfig(tsconfigPath);
    checker = program.getTypeChecker();
    aggType = resolveAggregateType(program, checker, entryPath, 'testAggregate');
    sourceFile = program.getSourceFile(path.resolve(entryPath))!;
});

describe('aggregateNavigator', () => {
    describe('createProgramFromConfig', () => {
        it('should create a valid program from the fixture tsconfig', () => {
            expect(program).toBeDefined();
            expect(program.getSourceFiles().length).toBeGreaterThan(0);
        });
    });

    describe('resolveAggregateType', () => {
        it('should resolve the testAggregate export', () => {
            expect(aggType).toBeDefined();
        });

        it('should throw for a non-existent export', () => {
            expect(() =>
                resolveAggregateType(program, checker, entryPath, 'nonExistent')
            ).toThrow(/not found/);
        });
    });

    describe('extractCommandPayloads', () => {
        let commands: Map<string, ts.Type>;

        beforeAll(() => {
            commands = extractCommandPayloads(checker, aggType, sourceFile);
        });

        it('should extract commands with payloads', () => {
            expect(commands.has('register')).toBe(true);
            expect(commands.has('addSource')).toBe(true);
            expect(commands.has('amendSummary')).toBe(true);
            expect(commands.has('tag')).toBe(true);
            expect(commands.has('setMetadata')).toBe(true);
            expect(commands.has('updateNullable')).toBe(true);
        });

        it('should include all commands that resolve a payload (including deregister, clear)', () => {
            // Even no-arg commands produce a command object with a payload property
            expect(commands.has('deregister')).toBe(true);
            expect(commands.has('clear')).toBe(true);
        });
    });

    describe('extractEventPayloads', () => {
        let events: Map<string, ts.Type>;

        beforeAll(() => {
            events = extractEventPayloads(checker, aggType, sourceFile);
        });

        it('should extract events with payloads', () => {
            expect(events.has('registered')).toBe(true);
            expect(events.has('deregistered')).toBe(true);
            expect(events.has('sourceAdded')).toBe(true);
            expect(events.has('summaryAmended')).toBe(true);
            expect(events.has('tagged')).toBe(true);
            expect(events.has('metadataSet')).toBe(true);
            expect(events.has('nullableUpdated')).toBe(true);
        });

        it('should skip cleared event (has < 2 params)', () => {
            expect(events.has('cleared')).toBe(false);
        });
    });

    describe('extractStateType', () => {
        it('should return a non-null state type', () => {
            const stateType = extractStateType(checker, aggType, sourceFile);
            expect(stateType).not.toBeNull();
        });
    });
});

describe('typeConverter', () => {
    let converter: TypeToZodConverter;
    let commands: Map<string, ts.Type>;
    let events: Map<string, ts.Type>;
    let stateType: ts.Type;

    beforeAll(() => {
        converter = new TypeToZodConverter(checker, program, 'string');
        commands = extractCommandPayloads(checker, aggType, sourceFile);
        events = extractEventPayloads(checker, aggType, sourceFile);
        stateType = extractStateType(checker, aggType, sourceFile)!;
    });

    it('should convert a simple string property type', () => {
        // deregistered event has { status: 'closed' } — a string literal
        const deregistered = events.get('deregistered')!;
        const result = converter.convert(deregistered);
        expect(result).toContain('z.object');
        expect(result).toContain('status');
    });

    it('should convert Record type to z.record (possibly via shared schema)', () => {
        const metadata = commands.get('setMetadata')!;
        const result = converter.convert(metadata);
        // The Record<string, string> may be extracted as a shared "recordSchema"
        // Check the shared schemas map or the inline output
        const hasInlineRecord = result.includes('z.record(z.string()');
        const hasSharedRef = result.includes('recordSchema');
        expect(hasInlineRecord || hasSharedRef).toBe(true);
    });

    it('should convert array type to z.array', () => {
        const tag = commands.get('tag')!;
        const result = converter.convert(tag);
        expect(result).toContain('z.array(');
    });

    it('should convert deletedAt as z.string() (strict:false widens null away)', () => {
        // With strict:false in tsconfig, `string | null` is widened to `string`
        const result = converter.convert(stateType);
        expect(result).toContain('deletedAt: z.string()');
    });

    it('should handle boolean in state type', () => {
        const result = converter.convert(stateType);
        expect(result).toContain('z.boolean()');
    });

    it('should handle string literal union (enum) in state type', () => {
        const result = converter.convert(stateType);
        expect(result).toContain('z.enum(');
    });
});

describe('outputGenerator', () => {
    let commandPayloads: Map<string, ts.Type>;
    let eventPayloads: Map<string, ts.Type>;
    let stateType: ts.Type;

    beforeAll(() => {
        commandPayloads = extractCommandPayloads(checker, aggType, sourceFile);
        eventPayloads = extractEventPayloads(checker, aggType, sourceFile);
        stateType = extractStateType(checker, aggType, sourceFile)!;
    });

    function generate(opts: { includeState?: boolean } = {}): string {
        const converter = new TypeToZodConverter(checker, program, 'string');
        return generateOutput(converter, commandPayloads, eventPayloads, stateType, opts);
    }

    it('should contain commandSchemas and eventSchemas exports', () => {
        const output = generate();
        expect(output).toContain('export const commandSchemas');
        expect(output).toContain('export const eventSchemas');
    });

    it('should start with the generation header comment', () => {
        const output = generate();
        expect(output).toMatch(/^\/\/ GENERATED by redemeine/);
    });

    it('should contain import { z } from zod', () => {
        const output = generate();
        expect(output).toContain("import { z } from 'zod'");
    });

    it('should declare shared type schemas before commandSchemas', () => {
        const output = generate();
        // Shared types like summarySchema or propertySchema should appear
        // before the commandSchemas block if aliasSymbol is preserved
        const commandSchemasIdx = output.indexOf('export const commandSchemas');
        // Check that any `const ...Schema = ` declarations appear before commandSchemas
        const sharedDeclarationPattern = /^const \w+Schema = /m;
        const match = sharedDeclarationPattern.exec(output);
        if (match) {
            expect(match.index).toBeLessThan(commandSchemasIdx);
        }
    });

    it('should include stateSchema when includeState is true', () => {
        const output = generate({ includeState: true });
        expect(output).toContain('export const stateSchema');
    });

    it('should omit stateSchema when includeState is false', () => {
        const output = generate({ includeState: false });
        expect(output).not.toContain('stateSchema');
    });
});

describe('extractZodSchemas (e2e)', () => {
    const outFile = path.resolve(__dirname, '__extractZodSchemas_test_output__.ts');

    afterAll(() => {
        if (existsSync(outFile)) {
            rmSync(outFile);
        }
    });

    it('should generate a valid schema file from the fixture', () => {
        extractZodSchemas({
            tsconfig: tsconfigPath,
            entry: entryPath,
            aggregateExport: 'testAggregate',
            outFile,
            includeState: true,
        });

        expect(existsSync(outFile)).toBe(true);

        const content = readFileSync(outFile, 'utf-8');
        expect(content).toContain("import { z } from 'zod'");
        expect(content).toContain('commandSchemas');
        expect(content).toContain('eventSchemas');
        expect(content).toContain('stateSchema');
    });
});
