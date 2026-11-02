import { current, Immer, isDraft } from 'immer';
import type { Event } from '@redemeine/kernel';
import type { EntityCommandTarget } from '../types/entityMount';
import { resolveEntityTarget } from './entityCommandTarget';
import { assertSynchronous } from '../plugins/descriptor';

type Branch = Record<string | number, unknown>;

// Descriptor copying also keeps class copies from invoking inherited PK setters.
const { produce } = new Immer({ useStrictShallowCopy: true });

function copyWith(value: object, replacements: object): Branch {
  return Object.create(Object.getPrototypeOf(value), {
    ...Object.getOwnPropertyDescriptors(value), ...Object.getOwnPropertyDescriptors(replacements)
  });
}

// Replace the path, not a borrowed raw subtree: objects inserted earlier in an outer
// transaction are not necessarily drafts. The same boundary handles subsequent events.
function replacePath(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  if (!path.length) return replacement;
  const [key, ...rest] = path;
  const branch = value as Branch;
  const next = replacePath(branch[key!], rest, replacement);
  if (!Array.isArray(value)) return copyWith(branch, { [key!]: next });
  const owned = [...value];
  Object.defineProperty(owned, key!, { value: next, enumerable: true, writable: true, configurable: true });
  return owned;
}

export function applyEntityEvent(draft: Branch, event: Event, targets: readonly EntityCommandTarget[], projector: Function): void {
  const selected = resolveEntityTarget(draft, event.payload, targets, true);
  const state = isDraft(selected.state) ? current(selected.state) : selected.state;
  // Initialize own data before drafting: draft assignment can invoke inherited setters.
  const initial: unknown = selected.isNew ? copyWith(state as object, selected.identity) : state;
  const next = produce(initial, leaf => {
    assertSynchronous(projector(leaf, event));
  });
  const path = [...selected.path];
  let replacement: unknown = next;
  if (selected.isNew) {
    const container = path.reduce<unknown>((parent, key) => (parent as Branch)[key], draft) as unknown[];
    replacement = [...container, next];
  }
  const [key, ...rest] = path;
  draft[key!] = replacePath(draft[key!], rest, replacement);
}
