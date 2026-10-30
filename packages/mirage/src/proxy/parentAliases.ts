import type { MountMetadata } from '../mirage.types';
import { readProperty } from '../runtimeDefinition';
import { isStaticListCommand } from './collectionProxy';

export function parentAliases(builder: object, mounts: Record<string, MountMetadata>, prefix: string[] = []) {
  return Object.entries(mounts).flatMap(([key, mount]) => {
    if (mount.kind !== 'list' || !mount.semanticName) return [];
    const suffix = mount.semanticName.charAt(0).toUpperCase() + mount.semanticName.slice(1);
    return (mount.commandNames ?? []).flatMap(command => {
      const path = [...prefix, mount.commandPrefix, command];
      const name = path.map((part, index) => index ? part.charAt(0).toUpperCase() + part.slice(1) : part).join('');
      return isStaticListCommand(builder, name, mount, prefix.length + 1)
        ? [{ name: command + suffix, key, command, mount }] : [];
    });
  });
}

/** Return the actual collection method so argument adaptation and dispatch have one owner. */
export function parentAlias(property: string, builder: object, mounts: Record<string, MountMetadata>, prefix: string[], collection: (key: string, mount: MountMetadata) => unknown): unknown {
  const alias = parentAliases(builder, mounts, prefix).find(entry => entry.name === property);
  return alias ? readProperty(collection(alias.key, alias.mount), alias.command) : undefined;
}
