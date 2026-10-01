import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createProgramFromConfig } from './extract/aggregateNavigator';
import { navigateRegistries } from './extract/schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from './extract/schemaRegistryOutputGenerator';
import { plainObject, requiredString, validateSelections } from './schemaRegistryManifest';
import type { SchemaRegistrySelection } from './schemaRegistryManifest';

export interface ExtractSchemaRegistriesOptions {
  tsconfig: string;
  outFile: string;
  definitions: readonly SchemaRegistrySelection[];
}

export function extractSchemaRegistries(options: ExtractSchemaRegistriesOptions): void {
  const input = plainObject(options, ['tsconfig', 'outFile', 'definitions'], 'options');
  const tsconfig = requiredString(input.tsconfig, 'options.tsconfig');
  const outFile = resolve(requiredString(input.outFile, 'options.outFile'));
  const selections = validateSelections(input.definitions);
  const program = createProgramFromConfig(tsconfig);
  const definitions = navigateRegistries(program, selections);
  // Complete every selection and conversion before touching the destination.
  const output = generateSchemaRegistryOutput(program.getTypeChecker(), definitions);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, output, 'utf8');
}
