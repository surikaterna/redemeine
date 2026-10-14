import type { MirageBuilder } from './runtimeDefinition';

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
  for (const [name, mount] of Object.entries(builder.mounts ?? {})) {
    const collection = state && typeof state === 'object' ? Reflect.get(state, name) : undefined;
    const entries: unknown[] = mount.kind === 'list' && Array.isArray(collection) ? collection
      : mount.kind === 'map' && collection && typeof collection === 'object' ? Object.values(collection) : [];
    validateEntityNames(name, entries, mount.commandNames ?? []);
  }
}
