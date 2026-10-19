import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createProgramFromConfig, resolveAggregateType } from './extract/aggregateNavigator';
import { resolveProjectionState } from './extract/projectionNavigator';
import { generateProjectionOutput } from './extract/projectionOutputGenerator';
import { JsonSchemaConverter } from './extract/jsonSchemaConverter';
import { jsonSchemaDocument, validateSchemaOutput, type SchemaOutputOptions } from './extract/jsonSchemaOutput';
import { schemaPolicyForEntry } from './extract/schemaConfig';
import { schemaAwareConversion } from './extract/schemaAwareConversion';
import { requireStructuralJson, assertStructuralJson } from './extract/jsonSchemaPolicy';
import { projectionSchemaDeclaration } from './extract/schemaDeclarations';

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
  const policy = schemaPolicyForEntry(options.entry);
  const definition = resolveAggregateType(program, program.getTypeChecker(), options.entry, options.projectionExport);
  const declaration = projectionSchemaDeclaration(program, definition, options.entry, options.projectionExport);
  const converter = schemaAwareConversion(program, policy, options.outFile);
  const path = `${options.projectionExport}.initialState`;
  if (options.format === 'json-schema') {
    requireStructuralJson(policy);
    assertStructuralJson(program.getTypeChecker(), state, path, declaration, policy.maxDepth, policy.maxProvenanceDepth);
  }
  const zod = converter.convert(state, path, declaration);
  const output = options.format === 'json-schema'
    ? `${JSON.stringify(jsonSchemaDocument(new JsonSchemaConverter(program, policy.maxDepth, policy.maxProvenanceDepth).convert(state, path), options.target), null, 2)}\n`
    : generateProjectionOutput(zod, [...converter.imports]);
  const outPath = resolve(options.outFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output, 'utf-8');
}
