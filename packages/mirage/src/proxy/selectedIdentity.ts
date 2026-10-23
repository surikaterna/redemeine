import { singular, toCamelCase, toSnakeCase } from '@redemeine/aggregate';
import type { InvocationContext, MountMetadata } from '../mirage.types';
import { readProperty } from '../runtimeDefinition';

// Mirror the mounted target resolver's leaf aliases using the actual registration metadata.
function aliases(mount: MountMetadata, field: string): string[] {
  const name = mount.commandPrefix;
  const names = new Set([name, singular(name), toCamelCase(name), singular(toCamelCase(name)), toSnakeCase(name), singular(toSnakeCase(name))]);
  const suffix = field.charAt(0).toUpperCase() + field.slice(1);
  return [...names].map(prefix => prefix + suffix).concat(field);
}

function equalIdentity(left: unknown, right: unknown): boolean {
  const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
  return scalar(left) && scalar(right) && String(left) === String(right);
}

export function assertSelectedIdentity(payload: unknown, context: InvocationContext, final = false): void {
  if (!context.resolveState) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Missing selected identity');
  const mount = context.selectedMount;
  if (!mount) throw new Error('Missing selected mount');
  const fields = mount.kind === 'map' ? ['key'] : typeof mount.pk === 'string' ? [mount.pk] : mount.pk ?? ['id'];
  if (!fields.length) throw new Error('Missing selected identity');
  const used = new Set<string>();
  const composite = mount.kind === 'list' ? readProperty(payload, '__entityPk') : undefined;
  if (composite !== undefined && (!composite || typeof composite !== 'object' || Array.isArray(composite))) throw new TypeError('Invalid selected identity');
  for (const field of fields) {
    const keys = aliases(mount, field);
    if (mount.kind === 'list' && fields.length === 1 && field !== 'id') keys.push(...aliases(mount, 'id'));
    const present = [...new Set(keys)].filter(key => Object.hasOwn(payload, key));
    const values = present.map(key => readProperty(payload, key));
    if (composite && Object.hasOwn(composite, field)) {
      present.push(`__entityPk.${field}`);
      values.push(readProperty(composite, field));
    }
    const expected = context.entityPk ? context.entityPk[field] : context.idsPayload[field];
    if (values.some(value => !equalIdentity(value, expected))) throw new Error(`Conflicting selected identity: ${field}`);
    if (present.some(key => used.has(key))) throw new Error('Ambiguous selected identity');
    present.forEach(key => used.add(key));
    if (final && !values.length) throw new Error('Missing selected identity');
  }
}
