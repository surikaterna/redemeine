import type * as ts from 'typescript';
import type { SchemaRegistrySelection } from '../schemaRegistryManifest';
import { navigateRegistries } from './schemaRegistryNavigator';
import { generateSchemaRegistryOutput } from './schemaRegistryOutputGenerator';

export function reconcileSchemaViews(program: ts.Program, selections: readonly SchemaRegistrySelection[]): void {
  if (selections.length < 2) return;
  let expected: string | undefined;
  for (const selection of selections) {
    // Compare the faithful normalized schemas, not checker Type identity or structural assignability.
    const output = generateSchemaRegistryOutput(program.getTypeChecker(), navigateRegistries(program, [selection]));
    if (expected !== undefined && output !== expected) {
      throw new Error(`${selection.entry}:${selection.export}: incompatible schema views for canonical aliases; select one view explicitly or exclude the other routes`);
    }
    expected = output;
  }
}
