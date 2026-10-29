import type { InvocationContext, MountMetadata } from '../mirage.types';
import type { ProxyContext } from './proxyContext';
import { readProperty } from '../runtimeDefinition';
import { equalIdentity } from './selectedIdentity';

export function nestedCollection(property: string, path: string[], prefix: string[], selection: InvocationContext, ctx: ProxyContext): unknown {
  const mounts = readProperty(selection.selectedMount?.entity, 'mounts');
  const mount = readProperty(mounts, property) as MountMetadata | undefined;
  if (mount?.kind !== 'list') return undefined;
  const resolveCollection = () => readProperty(selection.resolveState!(), property);
  return ctx.makeCollectionProxy([...path, property], [...prefix, mount.commandPrefix], mount,
    { idsPayload: {}, packPrefix: [], ancestors: [...selection.ancestors ?? [], selection], resolveCollection });
}

export function bindAncestors(payload: unknown, context: InvocationContext): unknown {
  if (!context.ancestors?.length) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Missing ancestor identity payload');
  const bindings: [string, unknown][] = [];
  for (const ancestor of context.ancestors) {
    const mount = ancestor.selectedMount!;
    const entity = ancestor.resolveState!();
    const fields = mount.kind === 'map' ? ['key'] : typeof mount.pk === 'string' ? [mount.pk] : mount.pk ?? ['id'];
    for (const field of fields) {
      const key = mount.commandPrefix + field.charAt(0).toUpperCase() + field.slice(1);
      const value = mount.kind === 'map' ? ancestor.selectedMapKey : readProperty(entity, field);
      if (Object.hasOwn(payload, key) && !equalIdentity(readProperty(payload, key), value)) throw new Error(`Conflicting ancestor identity: ${key}`);
      bindings.push([key, value]);
    }
  }
  // Overlay descriptors before creation so frozen own qualifiers need no mutation.
  const descriptors = Object.getOwnPropertyDescriptors(payload);
  for (const [key, value] of bindings) {
    descriptors[key] = { value, enumerable: true, writable: true, configurable: true };
  }
  return Object.create(Object.getPrototypeOf(payload), descriptors);
}
