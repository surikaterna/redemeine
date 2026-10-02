import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type SchemaRegistrySelection = {
  kind: 'aggregate' | 'projection';
  entry: string;
  export: string;
  name?: string;
};

export type SchemaRegistryDiscovery = {
  kind: 'aggregate' | 'projection';
  entry: string;
  exclude?: readonly string[];
  names?: Readonly<Record<string, string>>;
};

function dataArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) throw new Error(`${path}: unknown array field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}[${key}]: expected an enumerable data property`);
  }
  if (Object.keys(value).length !== value.length) throw new Error(`${path}: sparse arrays unsupported`);
  return value;
}

export function validateDiscovery(value: unknown): SchemaRegistryDiscovery[] {
  return dataArray(value, 'discover').map((item: unknown, index: number) => {
    const path = `discover[${index}]`;
    const input = plainObject(item, ['kind', 'entry', 'exclude', 'names'], path);
    if (input.kind !== 'aggregate' && input.kind !== 'projection') throw new Error(`${path}.kind: expected aggregate or projection`);
    const result: SchemaRegistryDiscovery = { kind: input.kind, entry: requiredString(input.entry, `${path}.entry`) };
    if (Object.hasOwn(input, 'exclude')) {
      result.exclude = dataArray(input.exclude, `${path}.exclude`).map((name: unknown) => requiredString(name, `${path}.exclude`));
      if (new Set(result.exclude).size !== result.exclude.length) throw new Error(`${path}.exclude: duplicate export`);
    }
    if (Object.hasOwn(input, 'names')) {
      const keys = input.names && typeof input.names === 'object' ? Object.getOwnPropertyNames(input.names) : [];
      const names = plainObject(input.names, keys, `${path}.names`);
      result.names = Object.fromEntries(Object.entries(names).map(([key, name]) =>
        [requiredString(key, `${path}.names key`), requiredString(name, `${path}.names.${key}`)]));
    }
    return result;
  });
}

export function registryInputs(input: Record<string, unknown>) {
  if (!Object.hasOwn(input, 'definitions') && !Object.hasOwn(input, 'discover')) throw new Error('expected definitions or discover');
  return {
    definitions: Object.hasOwn(input, 'definitions') ? validateSelections(input.definitions) : [],
    discover: Object.hasOwn(input, 'discover') ? validateDiscovery(input.discover) : [],
  };
}

export function plainObject(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${path}: expected a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw new Error(`${path}: unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key}: expected a data property`);
    if (!descriptor.enumerable) throw new Error(`${path}.${key}: hidden fields unsupported`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path}: expected a nonempty string`);
  return value;
}

export function validateSelections(value: unknown): SchemaRegistrySelection[] {
  return dataArray(value, 'definitions').map((item: unknown, index: number) => {
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

export function readSchemaRegistryManifest(file: string): { tsconfig: string; definitions: SchemaRegistrySelection[]; discover: SchemaRegistryDiscovery[] } {
  const absolute = resolve(file);
  const manifest = plainObject(JSON.parse(readFileSync(absolute, 'utf8')), ['version', 'tsconfig', 'definitions', 'discover'], 'manifest');
  if (manifest.version !== 1) throw new Error('manifest.version: expected 1');
  const base = dirname(absolute);
  const inputs = registryInputs(manifest);
  return {
    tsconfig: resolve(base, requiredString(manifest.tsconfig, 'manifest.tsconfig')),
    definitions: inputs.definitions.map((selection) => ({
      ...selection, entry: resolve(base, selection.entry),
    })),
    discover: inputs.discover.map((discovery) => ({ ...discovery, entry: resolve(base, discovery.entry) })),
  };
}
