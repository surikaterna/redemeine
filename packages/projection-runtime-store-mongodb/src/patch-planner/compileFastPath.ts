import { buildTypeGuardExpr } from './exprBuilders';
import { toMongoPath } from './mongoPath';
import { isArrayIndexLike, isNumericArrayIndex, parentTokens } from './pointer';
import { readAtTokens } from './stateReader';
import type { MongoPatchCompiledPlan, PlannerRuntime } from './types';

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
