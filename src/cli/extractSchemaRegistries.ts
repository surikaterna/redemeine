import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createProgramFromConfig } from './extract/aggregateNavigator';
import { navigateRegistries } from './extract/schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from './extract/schemaRegistryOutputGenerator';
import { plainObject, requiredString, registryInputs } from './schemaRegistryManifest';
import type { SchemaRegistrySelection, SchemaRegistryDiscovery } from './schemaRegistryManifest';
import { discoverRegistrySelections } from './extract/schemaRegistryDiscovery';

export interface ExtractSchemaRegistriesOptions {
  tsconfig: string;
  outFile: string;
  definitions?: readonly SchemaRegistrySelection[];
  discover?: readonly SchemaRegistryDiscovery[];
}

export function extractSchemaRegistries(options: ExtractSchemaRegistriesOptions): void {
  const input = plainObject(options, ['tsconfig', 'outFile', 'definitions', 'discover'], 'options');
  const tsconfig = requiredString(input.tsconfig, 'options.tsconfig');
  const outFile = resolve(requiredString(input.outFile, 'options.outFile'));
  const inputs = registryInputs(input);
  const program = createProgramFromConfig(tsconfig);
  const selections = discoverRegistrySelections(program, inputs.definitions, inputs.discover);
  const definitions = navigateRegistries(program, selections);
  // Complete every selection and conversion before touching the destination.
  const output = generateSchemaRegistryOutput(program.getTypeChecker(), definitions);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, output, 'utf8');
}
