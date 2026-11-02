import type { InvocationContext } from '../mirage.types';
import { readProperty } from '../runtimeDefinition';

export function equalIdentity(left: unknown, right: unknown): boolean {
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
  for (const field of fields) {
    const present = Object.hasOwn(payload, field);
    const expected = context.entityPk ? context.entityPk[field] : context.idsPayload[field];
    if (present && !equalIdentity(readProperty(payload, field), expected)) throw new Error(`Conflicting selected identity: ${field}`);
    if (final && !present) throw new Error('Missing selected identity');
  }
}
