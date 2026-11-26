import { isPortableProjectionChangeJson, isPortableProjectionChangeKey } from './projectionChangeJson';
import type { ProjectionChangePatchOperation, ProjectionChangeTransition } from './projectionChanges';
import type { ProjectionJsonObject, ProjectionJsonValue } from './sourceCommit';

export function formatProjectionChangePointer(path: readonly (string | number)[]): string {
  return path.map((token) => `/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

export function parseProjectionChangePointer(path: string): string[] | undefined {
  if (path === '') return [];
  if (!path.startsWith('/')) return undefined;
  const tokens = path.slice(1).split('/');
  for (const [index, token] of tokens.entries()) {
    if (/~(?![01])/u.test(token)) return undefined;
    const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isPortableProjectionChangeKey(decoded) || decoded === '__proto__') return undefined;
    tokens[index] = decoded;
  }
  return tokens;
}

type Container = ProjectionJsonObject | ProjectionJsonValue[];
type Branch = { container: Container; key: string };

function isContainer(value: ProjectionJsonValue | undefined): value is Container {
  return value !== null && typeof value === 'object';
}

function arrayIndex(key: string, length: number, insert: boolean): number | undefined {
  if (key === '-' && insert) return length;
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length + Number(insert) ? index : undefined;
}

function readChild(container: Container, key: string): ProjectionJsonValue | undefined {
  if (Array.isArray(container)) {
    const index = arrayIndex(key, container.length, false);
    return index === undefined ? undefined : container[index];
  }
  return Object.hasOwn(container, key) ? container[key] : undefined;
}

function writable(container: Container, owned: WeakSet<Container>): Container {
  if (owned.has(container)) return container;
  const copy = Array.isArray(container) ? container.slice() : { ...container };
  owned.add(copy);
  return copy;
}

function setChild(container: Container, key: string, value: ProjectionJsonValue): void {
  Object.defineProperty(container, key, { value, configurable: true, enumerable: true, writable: true });
}

function applyAtParent(
  container: Container, key: string, op: ProjectionChangePatchOperation, owned: WeakSet<Container>
): Container | undefined {
  if (Array.isArray(container)) {
    const index = arrayIndex(key, container.length, op.op === 'add');
    if (index === undefined) return undefined;
    const array = writable(container, owned) as ProjectionJsonValue[];
    if (op.op === 'replace') array[index] = op.value;
    else if (op.op === 'remove') array.splice(index, 1);
    else array.splice(index, 0, op.value);
    return array;
  }
  if (op.op !== 'add' && !Object.hasOwn(container, key)) return undefined;
  const object = writable(container, owned) as ProjectionJsonObject;
  if (op.op === 'remove') delete object[key];
  else setChild(object, key, op.value);
  return object;
}

function applyOperation(
  state: ProjectionJsonValue | undefined, op: ProjectionChangePatchOperation, path: readonly string[],
  owned: WeakSet<Container>
): ProjectionJsonValue | undefined {
  if (!path.length) return op.op === 'remove' || (op.op === 'replace' && state === undefined) ? undefined : op.value;
  const parents: Branch[] = [];
  let current = state;
  for (const key of path.slice(0, -1)) {
    if (!isContainer(current)) return undefined;
    parents.push({ container: current, key });
    current = readChild(current, key);
  }
  if (!isContainer(current)) return undefined;
  let next = applyAtParent(current, path[path.length - 1]!, op, owned);
  if (next === undefined) return undefined;
  for (let parent = parents.pop(); parent; parent = parents.pop()) {
    const container = writable(parent.container, owned);
    setChild(container, parent.key, next);
    next = container;
  }
  return next;
}

function isValidOperation(op: ProjectionChangePatchOperation): boolean {
  if (!op || typeof op.path !== 'string') return false;
  if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') return false;
  return Object.keys(op).every((key) => key === 'op' || key === 'path' || (key === 'value' && op.op !== 'remove'))
    && (op.op === 'remove' || (Object.hasOwn(op, 'value') && isPortableProjectionChangeJson(op.value)));
}

/** Applies a recorded transition to portable JSON in order, without mutating its input.
 * Undefined means the transition is invalid. Projection history does not delete root documents.
 */
export function replayProjectionChangeTransition(
  state: ProjectionJsonValue | undefined, transition: ProjectionChangeTransition
): ProjectionJsonValue | undefined {
  if (transition.changeType === 'noop') return transition.patch.length === 0 ? state : undefined;
  const [first] = transition.patch;
  if (transition.changeType === 'create') {
    if (state !== undefined || transition.patch.length !== 1 || first?.op !== 'add' || first.path !== '') return undefined;
  } else if (transition.changeType !== 'update' || state === undefined || !transition.patch.length) return undefined;
  // Only this transition's copies are writable. A borrowed value can occur at several paths.
  const owned = new WeakSet<Container>();
  let next = state;
  for (const op of transition.patch) {
    if (!isValidOperation(op)) return undefined;
    const path = parseProjectionChangePointer(op.path);
    if (!path) return undefined;
    next = applyOperation(next, op, path, owned);
    if (next === undefined) return undefined;
  }
  return next;
}
