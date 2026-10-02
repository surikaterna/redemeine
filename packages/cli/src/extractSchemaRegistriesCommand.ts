import { extractSchemaRegistries } from './extractSchemaRegistries';
import { readSchemaRegistryManifest, requiredString } from './schemaRegistryManifest';

export function extractSchemaRegistriesCommand(options: Record<string, string | boolean>): void {
  for (const key of Object.keys(options)) {
    if (!['manifest', 'out'].includes(key)) throw new Error(`unknown option --${key}`);
  }
  const manifest = requiredString(options.manifest, '--manifest');
  const outFile = requiredString(options.out, '--out');
  extractSchemaRegistries({ ...readSchemaRegistryManifest(manifest), outFile });
}
