import type { MirageBuilder } from './runtimeDefinition';
import { isStaticListCommand } from './proxy/collectionProxy';
import type { MountMetadata } from './mirage.types';
import { readProperty } from './runtimeDefinition';
import { parentAliases } from './proxy/parentAliases';

const protocols = new Set(['then', 'toJSON', 'toString', 'valueOf', 'inspect']);

function validateEntityNames(name: string, entries: unknown[], commands: readonly string[]): void {
  for (const command of commands) {
    if (protocols.has(command)) throw new Error(`Mirage entity collision: ${name}.${command}`);
  }
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    if (Object.keys(item).some(key => protocols.has(key))) throw new Error(`Mirage entity protocol name is reserved: ${name}`);
    for (const command of commands) {
      if (Object.hasOwn(item, command)) throw new Error(`Mirage entity collision: ${name}.${command}`);
    }
  }
}

function validateMounts(builder: MirageBuilder, mounts: Record<string, MountMetadata>, states: unknown[], prefix: string[] = [], commands: readonly string[] = [], aliasParent = true): void {
  const claimed = new Set(commands);
  for (const alias of aliasParent ? parentAliases(builder, mounts, prefix) : []) {
    if (protocols.has(alias.name) || claimed.has(alias.name) || states.some(state => !!state && typeof state === 'object' && Object.hasOwn(state, alias.name))) {
      throw new Error(`Mirage parent alias collision: ${[...prefix, alias.name].join('.')}`);
    }
    claimed.add(alias.name);
  }
  for (const [name, mount] of Object.entries(mounts)) {
    const commandPrefix = [...prefix, mount.commandPrefix].map((part, index) => index ? part.charAt(0).toUpperCase() + part.slice(1) : part).join('');
    for (const command of mount.commandNames ?? []) {
      const localName = `${commandPrefix}${command.charAt(0).toUpperCase()}${command.slice(1)}`;
      if (isStaticListCommand(builder, localName, mount, prefix.length + 1)
        && (command in Array.prototype || command === 'first' || protocols.has(command) || (command.trim() !== '' && !Number.isNaN(Number(command))))) {
        throw new Error(`Mirage list static collision: ${[...prefix, name, command].join('.')}`);
      }
    }
    const entries = states.flatMap(state => {
      const collection = readProperty(state, name);
      return mount.kind === 'list' && Array.isArray(collection) ? collection
        : mount.kind === 'map' && collection && typeof collection === 'object' ? Object.values(collection) : [];
    });
    const template = readProperty(mount.entity, 'initialState');
    const parentStates = template && typeof template === 'object' ? [...entries, template] : entries;
    validateEntityNames(name, parentStates, mount.commandNames ?? []);
    const nested = readProperty(mount.entity, 'mounts') as Record<string, MountMetadata> | undefined;
    if (nested) validateMounts(builder, nested, parentStates, [...prefix, mount.commandPrefix], mount.commandNames ?? [], aliasParent && mount.kind === 'list');
  }
}

export function validateMirageNames(builder: MirageBuilder, state: unknown): void {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Mirage root state must be a domain record');
  const stateKeys = state && typeof state === 'object' ? Object.keys(state) : [];
  const commands = Object.keys(builder.commandCreators);
  const selectors = Object.keys(builder.selectors ?? {});
  const claimed = new Set<string>();
  for (const name of [...stateKeys, ...commands, ...selectors]) {
    if (protocols.has(name)) throw new Error(`Mirage protocol name is reserved: ${name}`);
    if (claimed.has(name)) throw new Error(`Mirage namespace collision: ${name}`);
    claimed.add(name);
  }
  validateMounts(builder, builder.mounts ?? {}, [state], [], [...commands, ...selectors]);
}
