import { singular } from '@redemeine/aggregate';
import type { InvocationContext, MountMetadata } from '../mirage.types';
import { readProperty } from '../runtimeDefinition';
import { selectFromListEntity } from './collectionProxy';

export function selectedCommandMount(name: string, builder: object, selected: MountMetadata): MountMetadata {
  const targets = readProperty(readProperty(builder, 'pure'), 'commandTargets');
  const chain = targets && Object.hasOwn(targets, name) ? readProperty(targets, name) : undefined;
  if (!Array.isArray(chain) || chain.length !== 1) throw new Error('Missing or incompatible selected command registration');
  const target: unknown = chain[0];
  const kind = readProperty(target, 'kind');
  const statePath = readProperty(target, 'statePath');
  const commandPrefix = readProperty(target, 'commandPrefix');
  const pk = readProperty(target, 'pk');
  if ((kind !== 'list' && kind !== 'map') || kind !== selected.kind || typeof commandPrefix !== 'string'
    || !Array.isArray(statePath) || statePath.length !== selected.statePath.length
    || !statePath.every((part, index) => typeof part === 'string' && part === selected.statePath[index])
    || (pk !== undefined && typeof pk !== 'string' && (!Array.isArray(pk) || !pk.every(field => typeof field === 'string')))) {
    throw new Error('Incompatible selected command registration');
  }
  return { kind, statePath: [...statePath], commandPrefix, pk };
}

// Selection uses the live mount; invocation uses the winning command's own identity contract.
export function selectedCommandContext(name: string, selection: InvocationContext, builder: object): InvocationContext {
  if (!selection.resolveState) return selection;
  if (!selection.selectedMount) throw new Error('Missing selected mount');
  const mount = selectedCommandMount(name, builder, selection.selectedMount);
  const entity = selection.resolveState();
  if (mount.kind === 'list') {
    return { ...selectFromListEntity(mount.statePath.at(-1)!, mount, entity), resolveState: selection.resolveState };
  }
  const key = selection.selectedMapKey;
  if (key === undefined) throw new Error('Missing selected map key');
  const local = mount.statePath.at(-1)!;
  return { idsPayload: { key, [`${singular(local)}Key`]: key, [`${local}Key`]: key },
    packPrefix: [key], selectedMount: mount, selectedMapKey: key, resolveState: selection.resolveState };
}
