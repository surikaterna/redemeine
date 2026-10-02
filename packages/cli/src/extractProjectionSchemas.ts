import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createProgramFromConfig } from './extract/aggregateNavigator';
import { resolveProjectionState } from './extract/projectionNavigator';
import { ProjectionTypeConverter } from './extract/projectionTypeConverter';
import { generateProjectionOutput } from './extract/projectionOutputGenerator';

export interface ExtractProjectionOptions {
  tsconfig: string;
  entry: string;
  projectionExport: string;
  outFile: string;
}

/** Resolve business state without executing projection code; validate before writing. */
export function extractProjectionSchemas(options: ExtractProjectionOptions): void {
  const program = createProgramFromConfig(options.tsconfig);
  const state = resolveProjectionState(program, options.entry, options.projectionExport);
  const converter = new ProjectionTypeConverter(program.getTypeChecker());
  const output = generateProjectionOutput(converter.convert(state, `${options.projectionExport}.initialState`));
  const outPath = resolve(options.outFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output, 'utf-8');
}
