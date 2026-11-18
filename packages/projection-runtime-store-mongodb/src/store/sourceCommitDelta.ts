import { parseProjectionChangePointer, type ProjectionChangePatchOperation, type ProjectionChangeTarget } from '@redemeine/projection-runtime-core';
import { patch6902ToMongoUpdatePlan } from '../patch6902ToMongoUpdatePlan';
import type { MongoPatchCompiledUpdateDocumentPlan } from '../patch-planner/types';

type Mutation = { kind: 'set' | 'unset' | 'push' | 'pop'; path: string };

function indexOf(token: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/u.test(token)) return undefined;
  const index = Number(token);
  return Number.isSafeInteger(index) ? index : undefined;
}

function readOwnMember(parent: unknown, key: string): unknown {
  if (Array.isArray(parent)) {
    const index = indexOf(key);
    return index === undefined || index >= parent.length ? undefined : parent[index];
  }
  if (!parent || typeof parent !== 'object' || !isField(key) || !Object.hasOwn(parent, key)) return undefined;
  return (parent as Record<string, unknown>)[key];
}

function isField(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key);
}

function safeMutation(op: ProjectionChangePatchOperation, original: unknown): Mutation | undefined {
  const tokens = parseProjectionChangePointer(op.path);
  if (!tokens?.length) return undefined;
  const ancestors = tokens.slice(0, -1);
  const leaf = tokens[tokens.length - 1]!;
  const parent = ancestors.reduce<unknown>(readOwnMember, original);
  if (!parent || typeof parent !== 'object') return undefined;
  if (!Array.isArray(parent)) {
    return isField(leaf) ? { kind: op.op === 'remove' ? 'unset' : 'set', path: tokens.join('.') } : undefined;
  }
  const index = indexOf(leaf);
  if (op.op === 'replace' && index !== undefined && index < parent.length) return { kind: 'set', path: tokens.join('.') };
  if (!ancestors.length) return undefined;
  const path = ancestors.join('.');
  if (op.op === 'add' && (leaf === '-' || index === parent.length)) return { kind: 'push', path };
  if (op.op === 'remove' && parent.length > 0 && (index === 0 || index === parent.length - 1)) return { kind: 'pop', path };
  return undefined;
}

function safeMutations(patch: readonly ProjectionChangePatchOperation[], original: unknown): Mutation[] | undefined {
  const mutations: Mutation[] = [];
  for (const op of patch) {
    const mutation = safeMutation(op, original);
    if (!mutation || (patch.length > 1 && (mutation.kind === 'push' || mutation.kind === 'pop'))) return undefined;
    mutations.push(mutation);
  }
  const sorted = mutations.map(({ path }) => path).sort((a, b) => a.split('.').length - b.split('.').length);
  const unique = new Set<string>();
  for (const path of sorted) {
    const parts = path.split('.');
    if (parts.some((_part, index) => unique.has(parts.slice(0, index + 1).join('.')))) return undefined;
    unique.add(path);
  }
  return mutations;
}

function planMatches(plan: MongoPatchCompiledUpdateDocumentPlan, mutations: readonly Mutation[]): boolean {
  const paths = { set: Object.keys(plan.set), unset: plan.unset, push: Object.keys(plan.push), pop: Object.keys(plan.pop) };
  return Object.values(paths).reduce((sum, group) => sum + group.length, 0) === mutations.length
    && mutations.every(({ kind, path }) => paths[kind].includes(path));
}

function isProvenArraySet(plan: MongoPatchCompiledUpdateDocumentPlan, original: unknown): boolean {
  if (!plan.orderedArraySet) return false;
  const { path, originalLength } = plan.orderedArraySet;
  const array = path.split('.').reduce<unknown>(readOwnMember, original);
  return Array.isArray(array) && array.length === originalLength && planMatches(plan, [{ kind: 'set', path }]);
}

function underState(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  return Object.fromEntries([...entries].map(([path, value]) => [`state.${path}`, value]));
}

/** Called only after the patch has been replayed against the transaction's revision-checked snapshot. */
export function buildSourceCommitDelta<TState>(
  change: ProjectionChangeTarget | undefined,
  original: unknown,
  finalDocument: TState,
  metadata: Record<string, unknown>
): Record<string, unknown> | undefined {
  const [transition] = change?.transitions ?? [];
  if (change?.transitions.length !== 1 || transition?.changeType !== 'update') return undefined;
  const patch = transition.patch;
  const plan = patch6902ToMongoUpdatePlan(patch, finalDocument, { coalesceGuardedArrayEdits: true });
  if (plan.mode !== 'compiled-update-document') return undefined;
  if (!isProvenArraySet(plan, original)) {
    const mutations = safeMutations(patch, original);
    if (!mutations?.length || !planMatches(plan, mutations)) return undefined;
  }
  // The revision-checked snapshot proves parents and indices; avoid dotted query semantics through arrays.
  const push = Object.entries(plan.push);
  const pop = Object.entries(plan.pop);
  return {
    $set: { ...metadata, ...underState(Object.entries(plan.set)) },
    ...(plan.unset.length ? { $unset: underState(plan.unset.map((path) => [path, ''])) } : {}),
    ...(push.length ? { $push: underState(push.map(([path, value]) => [path, { $each: [value] }])) } : {}),
    ...(pop.length ? { $pop: underState(pop) } : {})
  };
}
