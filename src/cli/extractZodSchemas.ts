import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
    createProgramFromConfig,
    resolveAggregateType,
    extractCommandPayloads,
    extractEventPayloads,
    extractStateType
} from './extract/aggregateNavigator';
import { TypeToZodConverter } from './extract/typeConverter';
import { generateOutput } from './extract/outputGenerator';

export interface ExtractZodOptions {
    /** Path to tsconfig.json */
    tsconfig: string;
    /** Path to the source file containing the aggregate export */
    entry: string;
    /** Name of the exported aggregate variable */
    aggregateExport: string;
    /** Output file path for generated Zod schemas */
    outFile: string;
    /** Whether to include state schema (default: true) */
    includeState?: boolean;
    /** How to handle Date types: 'string' (default) or 'date' */
    dateHandling?: 'string' | 'date';
}

/**
 * Extracts types from a built aggregate using the TypeScript Compiler API
 * and generates Zod schema source code.
 *
 * Navigates the aggregate's `commandCreators`, `pure.eventProjectors`,
 * and `initialState` to extract payload and state types, then converts
 * them recursively into Zod schema definitions.
 */
export function extractZodSchemas(options: ExtractZodOptions): void {
    const program = createProgramFromConfig(options.tsconfig);
    const checker = program.getTypeChecker();

    const sourceFile = program.getSourceFile(resolve(options.entry));
    if (!sourceFile) {
        throw new Error(`Source file not found: ${options.entry}`);
    }

    const aggType = resolveAggregateType(
        program, checker, options.entry, options.aggregateExport
    );

    const commandPayloads = extractCommandPayloads(checker, aggType, sourceFile);
    const eventPayloads = extractEventPayloads(checker, aggType, sourceFile);
    const stateType = extractStateType(checker, aggType, sourceFile);

    const converter = new TypeToZodConverter(
        checker, program, options.dateHandling ?? 'string'
    );

    const output = generateOutput(
        converter, commandPayloads, eventPayloads, stateType, options
    );

    const outPath = resolve(options.outFile);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf-8');
}
