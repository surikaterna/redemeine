import {
  parseProjectionChangePointer, type ProjectionChangePatchOperation, type ProjectionChangeTransition,
  type ProjectionSourceCommitDocument, type VerifiedProjectionSourceCommitStatePatch
} from '@redemeine/projection-runtime-core';
import { BSON } from 'mongodb';
import type { MongoSourceCommitPatchDecision } from '../types';
import { authoritativeMongoEdits } from './sourceCommitStateDelta';

type Mutation = { kind: '$set' | '$unset' | '$push' | '$pop'; path: string; value: unknown; newMemberOf?: string };

function indexOf(token: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/u.test(token)) return undefined;
  const index = Number(token);
  return Number.isSafeInteger(index) ? index : undefined;
}

function isField(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key);
}

function readOwnMember(parent: unknown, key: string): unknown {
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) return undefined;
  if (Array.isArray(parent) ? indexOf(key) === undefined : !isField(key)) return undefined;
  return (parent as Record<string, unknown>)[key];
}

function safeMutation(op: ProjectionChangePatchOperation, tokens: string[], original: unknown, single: boolean): Mutation | undefined {
  if (!tokens.length) return undefined;
  const ancestors = tokens.slice(0, -1);
  const leaf = tokens[tokens.length - 1]!;
  const parent = ancestors.reduce<unknown>(readOwnMember, original);
  if (!parent || typeof parent !== 'object') return undefined;
  const path = tokens.join('.');
  if (!Array.isArray(parent)) {
    if (!isField(leaf)) return undefined;
    if (op.op === 'remove') return { kind: '$unset', path, value: '' };
    return { kind: '$set', path, value: op.value, ...(!Object.hasOwn(parent, leaf) ? { newMemberOf: ancestors.join('.') } : {}) };
  }
  const index = indexOf(leaf);
  if (op.op === 'replace' && index !== undefined && index < parent.length) return { kind: '$set', path, value: op.value };
  if (!single || !ancestors.length) return undefined;
  return boundaryArrayMutation(op, ancestors.join('.'), leaf, index, parent.length);
}

function boundaryArrayMutation(
  op: ProjectionChangePatchOperation, path: string, leaf: string, index: number | undefined, length: number
): Mutation | undefined {
  if (op.op === 'add' && (leaf === '-' || index === length)) return { kind: '$push', path, value: { $each: [op.value] } };
  if (op.op === 'remove' && length > 0 && (index === 0 || index === length - 1)) {
    return { kind: '$pop', path, value: index === 0 ? -1 : 1 };
  }
  return undefined;
}

/** Collapse a shift to the outermost array on that branch, so numeric paths after the shift need no separate proof. */
function shiftArray(tokens: string[], original: unknown): string[] | undefined {
  let firstArray: string[] | undefined;
  let parent = original;
  for (let i = 0; i < tokens.length; i++) {
    if (Array.isArray(parent)) firstArray ??= tokens.slice(0, i);
    if (i === tokens.length - 1) return Array.isArray(parent) && firstArray?.length ? firstArray : undefined;
    parent = readOwnMember(parent, tokens[i]!);
  }
  return undefined;
}

function* operations(transitions: readonly ProjectionChangeTransition[]) {
  for (const transition of transitions) yield* transition.patch;
}

function collapsedArrays(transitions: readonly ProjectionChangeTransition[], original: unknown, finalDocument: unknown, single: boolean) {
  const arrays = new Map<string, Mutation>();
  for (const op of operations(transitions)) {
    if (op.op === 'replace') continue;
    const tokens = parseProjectionChangePointer(op.path);
    if (!tokens) continue;
    if (single && safeMutation(op, tokens, original, true)) continue;
    const path = shiftArray(tokens, original);
    if (!path) continue;
    const finalArray = path.reduce<unknown>(readOwnMember, finalDocument);
    if (Array.isArray(finalArray)) arrays.set(path.join('.'), { kind: '$set', path: path.join('.'), value: finalArray });
  }
  return arrays;
}

function coveredByArray(tokens: string[], arrays: ReadonlyMap<string, Mutation>): boolean {
  let prefix = '';
  for (const token of tokens.slice(0, -1)) {
    if (!isField(token)) return false;
    prefix += prefix ? `.${token}` : token;
    if (arrays.has(prefix)) return true;
  }
  return false;
}

function hasAncestor(path: string, mutations: ReadonlyMap<string, Mutation>): boolean {
  for (let dot = path.indexOf('.'); dot >= 0; dot = path.indexOf('.', dot + 1)) {
    if (mutations.has(path.slice(0, dot))) return true;
  }
  return false;
}

function formatUpdate(mutations: ReadonlyMap<string, Mutation>, metadata: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, Record<string, unknown>> = { $set: metadata };
  for (const { kind, path, value } of mutations.values()) {
    (update[kind] ??= {})[`state.${path}`] = value;
  }
  return update;
}

/** Translate edits proven by replay or derived from revision-checked immutable state. */
function buildSourceCommitDelta(
  transitions: readonly ProjectionChangeTransition[],
  original: unknown,
  finalDocument: unknown,
  metadata: Record<string, unknown>
): Record<string, unknown> | undefined {
  const single = transitions.reduce((count, { patch }) => count + patch.length, 0) === 1;
  const arrays = collapsedArrays(transitions, original, finalDocument, single);
  const mutations = new Map(arrays);
  const parentsWithNewMembers = new Set<string>();
  for (const op of operations(transitions)) {
    const tokens = parseProjectionChangePointer(op.path);
    if (!tokens || (op.op !== 'remove' && op.value === undefined)) return undefined;
    if (coveredByArray(tokens, arrays)) continue;
    const mutation = safeMutation(op, tokens, original, single);
    if (!mutation || mutations.has(mutation.path)) return undefined;
    // Mongo can add sibling fields in modifier sort order, not patch order.
    const parent = mutation.newMemberOf;
    if (parent !== undefined && parentsWithNewMembers.has(parent)) return undefined;
    if (parent !== undefined) parentsWithNewMembers.add(parent);
    mutations.set(mutation.path, mutation);
  }
  for (const path of mutations.keys()) if (hasAncestor(path, mutations)) return undefined;
  return formatUpdate(mutations, { ...metadata });
}

function fullWriteReason(
  document: ProjectionSourceCommitDocument,
  legacyFence: boolean,
  patch: VerifiedProjectionSourceCommitStatePatch | undefined
): Extract<MongoSourceCommitPatchDecision, { mode: 'full' }>['reason'] | undefined {
  if (legacyFence) return 'legacy-fence';
  if (document.expectedRevision === null) return 'creation';
  if (patch) return undefined;
  const hint = document.statePatch;
  if (!hint) return 'missing-state-patch';
  if (hint.kind === 'full' && (hint.reason === 'nonportable-state' || hint.reason === 'unrepresentable-patch')) return hint.reason;
  return 'invalid-state-patch';
}

export function planSourceDocumentWrite(
  document: ProjectionSourceCommitDocument,
  patch: VerifiedProjectionSourceCommitStatePatch | undefined,
  original: unknown,
  metadata: Record<string, unknown>
): { update: Record<string, unknown>; decision: MongoSourceCommitPatchDecision } {
  const reason = fullWriteReason(document, metadata.v2ObservedUpdatedAt !== undefined, patch);
  const full = { $set: { ...metadata, state: document.finalDocument } };
  if (!reason && patch) {
    if (patch.unchanged) {
      return { update: { $set: metadata }, decision: { mode: 'metadata-only' } };
    }
    const authoritative = patch.captured ? authoritativeMongoEdits(original, document.finalDocument) : undefined;
    if (authoritative?.length === 0) return { update: { $set: metadata }, decision: { mode: 'metadata-only' } };
    const transitions = authoritative
      ? [{ eventId: '', eventIndex: 0, changeType: 'update' as const, patch: authoritative }]
      : patch.transitions;
    const update = buildSourceCommitDelta(transitions, original, document.finalDocument, metadata);
    if (update) {
      // Repeated dotted prefixes can make the modifier document larger than full-state persistence.
      return BSON.calculateObjectSize(update) <= 16 * 1024 * 1024
        ? { update, decision: { mode: 'delta' } }
        : { update: full, decision: { mode: 'full', reason: 'modifier-capacity' } };
    }
  }
  return {
    update: full,
    decision: { mode: 'full', reason: reason ?? 'unsafe-delta' }
  };
}
