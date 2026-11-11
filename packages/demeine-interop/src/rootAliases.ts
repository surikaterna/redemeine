import { commandMetadata } from '@redemeine/aggregate';
import type { BridgeableAggregate, CommandCreators } from './types';

/** Use authored mount/command names, never semantic guesses from wire types. */
export function rootAliases<S extends object, C extends CommandCreators>(builder: BridgeableAggregate<S, C, unknown>) {
  return Object.values(builder.mounts ?? {}).flatMap(mount => {
    if (mount.kind !== 'list' || !mount.semanticName) return [];
    const suffix = mount.semanticName.charAt(0).toUpperCase() + mount.semanticName.slice(1);
    return (mount.commandNames ?? []).flatMap(command => {
      const key = mount.commandPrefix + command.charAt(0).toUpperCase() + command.slice(1);
      const registration = commandMetadata(builder, key);
      const target = registration?.targets[0];
      if (!registration?.isStatic || registration.targets.length !== 1 || target?.kind !== 'list'
        || target.statePath.length !== mount.statePath.length
        || !target.statePath.every((part, index) => part === mount.statePath[index])) return [];
      return [{ name: command + suffix, key }];
    });
  });
}
