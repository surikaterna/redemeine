import type { InvocationContext } from '../mirage.types';
import { readProperty } from '../runtimeDefinition';

type Index = { version: number; positions: Map<string, number> };
const indexes = new WeakMap<object, Map<string, Index>>();

function keyFor(entity: unknown, fields: string[]): string {
  return JSON.stringify(fields.map(key => {
    const value = readProperty(entity, key);
    return [key, typeof value === 'number' || typeof value === 'bigint' ? String(value) : value];
  }));
}

export function findEntityInCollection(collection: unknown[], selection: InvocationContext, version: number): unknown {
  const identity = selection.entityPk ?? { id: selection.idsPayload.id };
  const fields = Object.keys(identity).sort();
  const schema = JSON.stringify(fields);
  let schemas = indexes.get(collection);
  if (!schemas) { schemas = new Map(); indexes.set(collection, schemas); }
  let index = schemas.get(schema);
  if (!index || index.version !== version) {
    index = { version, positions: new Map(collection.map((entity, position) => [keyFor(entity, fields), position])) };
    schemas.set(schema, index);
  }
  const position = index.positions.get(keyFor(identity, fields));
  return position === undefined ? undefined : collection[position];
}
