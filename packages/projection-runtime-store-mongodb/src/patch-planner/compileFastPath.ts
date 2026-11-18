import { buildArrayLengthGuardExpr, buildTypeGuardExpr } from './exprBuilders';
import { toMongoPath } from './mongoPath';
import { isArrayIndexLike, isNumericArrayIndex, parentTokens } from './pointer';
import { readAtTokens } from './stateReader';
import type { MongoPatchCompiledPlan, PatchOperationEntry, PlannerRuntime } from './types';

export const tryCompileSimpleArrayReorder = <TState>(runtime: PlannerRuntime<TState>): MongoPatchCompiledPlan | null => {
  const { entries, fullDocument, state, cacheKey } = runtime;
  if (entries.length !== 2 || entries[0]?.op.op !== 'remove' || entries[1]?.op.op !== 'add') {
    return null;
  }

  const removeTokens = entries[0].tokens;
  const addTokens = entries[1].tokens;
  if (
    removeTokens.length <= 1 ||
    addTokens.length <= 1 ||
    !isNumericArrayIndex(removeTokens[removeTokens.length - 1] ?? '') ||
    !isNumericArrayIndex(addTokens[addTokens.length - 1] ?? '')
  ) {
    return null;
  }

  const removeParent = parentTokens(removeTokens);
  const addParent = parentTokens(addTokens);
  if (removeParent.join('/') !== addParent.join('/')) {
    return null;
  }

  const parentMongoPath = toMongoPath(removeParent);
  if (parentMongoPath === null) {
    return null;
  }

  const parentRead = readAtTokens(fullDocument, removeParent);
  if (!parentRead.found || !Array.isArray(parentRead.value)) {
    return null;
  }

  state.set[parentMongoPath] = parentRead.value;
  return {
    mode: 'compiled-update-document',
    set: state.set,
    unset: [...state.unset.values()],
    push: state.push,
    pop: state.pop,
    testGuards: state.testGuards,
    exprGuards: state.exprGuards,
    cacheKey
  };
};

export const tryCompileOrderedArraySet = <TState>(runtime: PlannerRuntime<TState>): MongoPatchCompiledPlan | null => {
  const { entries, state, fullDocument, cacheKey } = runtime;
  if (entries.length <= 1 || entries.some((entry) => !['add', 'remove'].includes(entry.op.op))) {
    return null;
  }

  const allIndexed = entries.every((entry) => entry.tokens.length > 1 && isArrayIndexLike(entry.tokens[entry.tokens.length - 1] ?? ''));
  if (!allIndexed) {
    return null;
  }

  const parents = entries.map((entry) => parentTokens(entry.tokens).join('/'));
  const parent = parents[0];
  if (!parent || !parents.every((candidate) => candidate === parent)) {
    return null;
  }

  const parentTokensParsed = parent.split('/');
  const mongoPath = toMongoPath(parentTokensParsed);
  const arrayRead = readAtTokens(fullDocument, parentTokensParsed);
  if (!mongoPath || !arrayRead.found || !Array.isArray(arrayRead.value)) {
    return null;
  }

  state.set[mongoPath] = arrayRead.value;
  state.exprGuards.push(buildTypeGuardExpr(parentTokensParsed, 'array'));
  return {
    mode: 'compiled-update-document',
    set: state.set,
    unset: [...state.unset.values()],
    push: state.push,
    pop: state.pop,
    testGuards: state.testGuards,
    exprGuards: state.exprGuards,
    cacheKey
  };
};

function validatedOriginalLength(entries: readonly PatchOperationEntry[], finalLength: number): number | undefined {
  const delta = entries.reduce((sum, { op }) => sum + Number(op.op === 'add') - Number(op.op === 'remove'), 0);
  const originalLength = finalLength - delta;
  if (originalLength < 0) return undefined;
  let length = originalLength;
  for (const { tokens, op } of entries) {
    const token = tokens[tokens.length - 1]!;
    const insert = op.op === 'add';
    const index = token === '-' && insert ? length : /^(0|[1-9][0-9]*)$/u.test(token) ? Number(token) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= length + Number(insert)) return undefined;
    length += Number(insert) - Number(op.op === 'remove');
  }
  return originalLength;
}

/** Immer splice patches replace shifted slots and then add or remove tail slots. */
export function tryCompileMixedArraySet<TState>(runtime: PlannerRuntime<TState>): MongoPatchCompiledPlan | null {
  const { entries, fullDocument, cacheKey } = runtime;
  if (!entries.some(({ op }) => op.op === 'replace') || !entries.some(({ op }) => op.op === 'add' || op.op === 'remove')) return null;
  const parent = parentTokens(entries[0]!.tokens);
  // Limit dotted expression guards to ordinary object ancestry.
  if (!parent.length || parent.some((key) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key) || key === '__proto__')) return null;
  const path = parent.join('.');
  if (!entries.every(({ tokens, op }) => tokens.length === parent.length + 1
    && parent.every((key, index) => key === tokens[index])
    && (op.op === 'replace' || op.op === 'add' || op.op === 'remove'))) return null;
  const result = readAtTokens(fullDocument, parent);
  if (!result.found || !Array.isArray(result.value)) return null;
  const originalLength = validatedOriginalLength(entries, result.value.length);
  if (originalLength === undefined) return null;
  return { mode: 'compiled-update-document', cacheKey, set: { [path]: result.value },
    unset: [], push: {}, pop: {}, testGuards: [], exprGuards: [buildArrayLengthGuardExpr(parent, originalLength)],
    orderedArraySet: { path, originalLength } };
}
