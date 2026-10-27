import { commandMetadata } from '@redemeine/aggregate';
import type { InvocationContext, MountMetadata } from '../mirage.types';
import { readProperty } from '../runtimeDefinition';
import { selectFromListEntity } from './collectionProxy';

// A selected parent cannot supply descendant identities. Classify the local
// registration even when shadowed; direct-command winner validation stays strict.
export function isSelectedDescendant(name: string, builder: object, selected: MountMetadata): boolean {
  const targets = commandMetadata(builder, name)?.targets;
  const ancestor = targets?.[0];
  return !!targets && targets.length > 1 && ancestor?.kind === selected.kind
    && ancestor.statePath.length === selected.statePath.length
    && ancestor.statePath.every((part, index) => part === selected.statePath[index]);
}

export function selectedCommandMount(name: string, builder: object, selected: MountMetadata): MountMetadata {
  const registration = commandMetadata(builder, name);
  if (!registration?.isWireWinner) throw new Error('Missing or shadowed selected command registration');
  const chain = registration.targets;
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
  return { idsPayload: { key },
    packPrefix: [key], selectedMount: mount, selectedMapKey: key, resolveState: selection.resolveState };
}
