import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type SchemaRegistrySelection = {
  kind: 'aggregate' | 'projection';
  entry: string;
  export: string;
  name?: string;
};

export function plainObject(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${path}: expected a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw new Error(`${path}: unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key}: expected a data property`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path}: expected a nonempty string`);
  return value;
}

export function validateSelections(value: unknown): SchemaRegistrySelection[] {
  if (!Array.isArray(value)) throw new Error('definitions: expected an array');
  return value.map((item: unknown, index: number) => {
    const path = `definitions[${index}]`;
    const selection = plainObject(item, ['kind', 'entry', 'export', 'name'], path);
    if (selection.kind !== 'aggregate' && selection.kind !== 'projection') {
      throw new Error(`${path}.kind: expected aggregate or projection`);
    }
    const result: SchemaRegistrySelection = {
      kind: selection.kind,
      entry: requiredString(selection.entry, `${path}.entry`),
      export: requiredString(selection.export, `${path}.export`),
    };
    if (Object.hasOwn(selection, 'name')) result.name = requiredString(selection.name, `${path}.name`);
    return result;
  });
}

export function readSchemaRegistryManifest(file: string): { tsconfig: string; definitions: SchemaRegistrySelection[] } {
  const absolute = resolve(file);
  const manifest = plainObject(JSON.parse(readFileSync(absolute, 'utf8')), ['version', 'tsconfig', 'definitions'], 'manifest');
  if (manifest.version !== 1) throw new Error('manifest.version: expected 1');
  const base = dirname(absolute);
  return {
    tsconfig: resolve(base, requiredString(manifest.tsconfig, 'manifest.tsconfig')),
    definitions: validateSelections(manifest.definitions).map((selection) => ({
      ...selection, entry: resolve(base, selection.entry),
    })),
  };
}
