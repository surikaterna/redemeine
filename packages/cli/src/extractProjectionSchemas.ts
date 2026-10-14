import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createProgramFromConfig } from './extract/aggregateNavigator';
import { resolveProjectionState } from './extract/projectionNavigator';
import { ProjectionTypeConverter } from './extract/projectionTypeConverter';
import { generateProjectionOutput } from './extract/projectionOutputGenerator';
import { JsonSchemaConverter } from './extract/jsonSchemaConverter';
import { jsonSchemaDocument, validateSchemaOutput, type SchemaOutputOptions } from './extract/jsonSchemaOutput';

export interface ExtractProjectionOptions extends SchemaOutputOptions {
  tsconfig: string;
  entry: string;
  projectionExport: string;
  outFile: string;
}

/** Resolve business state without executing projection code; validate before writing. */
export function extractProjectionSchemas(options: ExtractProjectionOptions): void {
  validateSchemaOutput(options);
  const program = createProgramFromConfig(options.tsconfig);
  const state = resolveProjectionState(program, options.entry, options.projectionExport);
  const converter = new ProjectionTypeConverter(program.getTypeChecker());
  const path = `${options.projectionExport}.initialState`;
  const zod = converter.convert(state, path);
  const output = options.format === 'json-schema'
    ? `${JSON.stringify(jsonSchemaDocument(new JsonSchemaConverter(program).convert(state, path), options.target), null, 2)}\n`
    : generateProjectionOutput(zod);
  const outPath = resolve(options.outFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output, 'utf-8');
}
