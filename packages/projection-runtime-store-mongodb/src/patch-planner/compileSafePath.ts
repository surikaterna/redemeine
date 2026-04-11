import { fallback } from './fallback';
import { tryCompileDeterministicRootOp } from './compileRootOperation';
import { buildPresenceGuardExpr, buildStrictEqualityExpr, buildTypeGuardExpr } from './exprBuilders';
import { toMongoPath } from './mongoPath';
import { buildMiddleArrayInsertPipeline, buildMiddleArrayRemovePipeline } from './pipelineBuilders';
import { isArrayIndexLike, isNumericArrayIndex, parentTokens, parsePointer } from './pointer';
import { readAtPointer, readAtTokens } from './stateReader';
import type {
  MongoPatchFallbackPlan,
  PatchOperationEntry,
  PlannerRuntime
} from './types';

const hasPushOrPop = <TState>(runtime: PlannerRuntime<TState>): boolean => {
  return Object.keys(runtime.state.push).length > 0 || Object.keys(runtime.state.pop).length > 0;
};

const asPointer = (tokens: readonly string[]): string => {
  return tokens.length === 0 ? '' : `/${tokens.join('/')}`;
};

const setAtPathFromFullDocument = <TState>(runtime: PlannerRuntime<TState>, path: string): boolean => {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    return false;
  }

  const mongoPath = toMongoPath(tokens);
  if (mongoPath === null) {
    return false;
  }

  const read = readAtTokens(runtime.fullDocument, tokens);
  if (!read.found) {
    return false;
  }

  runtime.state.set[mongoPath] = read.value;
  runtime.state.unset.delete(mongoPath);
  return true;
};

const compileArrayAppend = <TState>(runtime: PlannerRuntime<TState>, mongoParentPath: string, parentArray: ReadonlyArray<unknown>): boolean => {
  if (parentArray.length === 0) {
    return false;
  }

  runtime.state.push[mongoParentPath] = parentArray[parentArray.length - 1];
  return true;
};

const compileArrayIndexedAdd = <TState>(
  runtime: PlannerRuntime<TState>,
  mongoParentPath: string,
  resultArray: ReadonlyArray<unknown>,
  addIndex: number,
  opPath: string
): boolean => {
  const preLength = resultArray.length - 1;
  if (addIndex === preLength) {
    runtime.state.push[mongoParentPath] = resultArray[addIndex];
    return true;
  }

  if (addIndex < 0 || addIndex >= preLength || runtime.state.pipeline !== null || hasPushOrPop(runtime)) {
    return false;
  }

  const insertedValue = readAtPointer(runtime.fullDocument, opPath);
  if (!insertedValue.found) {
    return false;
  }

  runtime.state.pipeline = buildMiddleArrayInsertPipeline(mongoParentPath, addIndex, insertedValue.value);
  return true;
};

const compileArrayAdd = <TState>(runtime: PlannerRuntime<TState>, tokens: readonly string[], opPath: string): boolean => {
  const leaf = tokens[tokens.length - 1] ?? '';
  const parent = parentTokens(tokens);
  const mongoParentPath = toMongoPath(parent);
  if (mongoParentPath === null) {
    return false;
  }

  const parentState = readAtPointer(runtime.fullDocument, asPointer(parent));
  if (!parentState.found || !Array.isArray(parentState.value)) {
    return false;
  }

  runtime.state.exprGuards.push(buildTypeGuardExpr(parent, 'array'));

  if (leaf === '-') {
    return compileArrayAppend(runtime, mongoParentPath, parentState.value);
  }

  if (!isNumericArrayIndex(leaf)) {
    return false;
  }

  const addIndex = Number(leaf);
  if (addIndex < 0 || !Number.isInteger(addIndex)) {
    return false;
  }

  return compileArrayIndexedAdd(runtime, mongoParentPath, parentState.value, addIndex, opPath);
};

const removeArrayAtPath = <TState>(runtime: PlannerRuntime<TState>, tokens: readonly string[]): boolean => {
  const leaf = tokens[tokens.length - 1] ?? '';
  if (!isNumericArrayIndex(leaf)) {
    return false;
  }

  const parent = parentTokens(tokens);
  const mongoParentPath = toMongoPath(parent);
  if (mongoParentPath === null) {
    return false;
  }

  const removeAtIndex = Number(leaf);
  if (!Number.isInteger(removeAtIndex) || removeAtIndex < 0) {
    return false;
  }

  const parentState = readAtPointer(runtime.fullDocument, asPointer(parent));
  if (!parentState.found || !Array.isArray(parentState.value)) {
    return false;
  }

  runtime.state.exprGuards.push(buildTypeGuardExpr(parent, 'array'));
  const resultingLength = parentState.value.length;
  if (removeAtIndex === 0 || removeAtIndex === resultingLength) {
    runtime.state.pop[mongoParentPath] = removeAtIndex === 0 ? -1 : 1;
    delete runtime.state.set[mongoParentPath];
    runtime.state.unset.delete(mongoParentPath);
    return true;
  }

  if (removeAtIndex > 0 && removeAtIndex < resultingLength && runtime.state.pipeline === null && !hasPushOrPop(runtime)) {
    runtime.state.pipeline = buildMiddleArrayRemovePipeline(mongoParentPath, removeAtIndex);
    return true;
  }

  return false;
};

const removeObjectAtPath = <TState>(runtime: PlannerRuntime<TState>, tokens: readonly string[]): boolean => {
  const mongoPath = toMongoPath(tokens);
  if (mongoPath === null) {
    return false;
  }

  const parent = parentTokens(tokens);
  if (parent.length > 0) {
    runtime.state.exprGuards.push(buildTypeGuardExpr(parent, 'object'));
  }

  runtime.state.exprGuards.push(buildPresenceGuardExpr(tokens));
  runtime.state.unset.add(mongoPath);
  delete runtime.state.set[mongoPath];
  return true;
};

const removeAtPath = <TState>(runtime: PlannerRuntime<TState>, path: string): boolean => {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    return false;
  }

  const leaf = tokens[tokens.length - 1] ?? '';
  if (isArrayIndexLike(leaf)) {
    return removeArrayAtPath(runtime, tokens);
  }

  return removeObjectAtPath(runtime, tokens);
};

const compileTestOperation = <TState>(
  runtime: PlannerRuntime<TState>,
  entry: PatchOperationEntry
): MongoPatchFallbackPlan<TState> | null => {
  if (entry.tokens.length === 0) {
    runtime.state.exprGuards.push(buildStrictEqualityExpr([], entry.op.value));
    return null;
  }

  const mongoPath = toMongoPath(entry.tokens);
  if (mongoPath === null) {
    return fallback(runtime.fullDocument, 'unsafe-test-path', runtime.cacheKey);
  }

  runtime.state.testGuards.push({ path: mongoPath, value: entry.op.value });
  runtime.state.exprGuards.push(buildStrictEqualityExpr(entry.tokens, entry.op.value));
  return null;
};

const compileAddOrReplace = <TState>(
  runtime: PlannerRuntime<TState>,
  entry: PatchOperationEntry
): MongoPatchFallbackPlan<TState> | null => {
  const leaf = entry.tokens[entry.tokens.length - 1] ?? '';
  if (isArrayIndexLike(leaf)) {
    if (entry.op.op === 'replace') {
      if (!isNumericArrayIndex(leaf)) {
        return fallback(runtime.fullDocument, 'replace-array-index-invalid', runtime.cacheKey);
      }

      if (!setAtPathFromFullDocument(runtime, entry.op.path)) {
        return fallback(runtime.fullDocument, 'replace-array-index-missing', runtime.cacheKey);
      }

      runtime.state.exprGuards.push(buildTypeGuardExpr(parentTokens(entry.tokens), 'array'));
      return null;
    }

    return compileArrayAdd(runtime, entry.tokens, entry.op.path)
      ? null
      : fallback(runtime.fullDocument, 'add-array-index-not-compileable', runtime.cacheKey);
  }

  const parent = parentTokens(entry.tokens);
  if (parent.length > 0) {
    runtime.state.exprGuards.push(buildTypeGuardExpr(parent, 'object'));
  }

  if (entry.op.op === 'replace') {
    runtime.state.exprGuards.push(buildPresenceGuardExpr(entry.tokens));
  }

  return setAtPathFromFullDocument(runtime, entry.op.path)
    ? null
    : fallback(runtime.fullDocument, 'set-target-not-found-in-full-document', runtime.cacheKey);
};

const compileCopy = <TState>(runtime: PlannerRuntime<TState>, entry: PatchOperationEntry): MongoPatchFallbackPlan<TState> | null => {
  if (!entry.op.from) {
    throw new Error('RFC6902 copy operation requires "from".');
  }

  const fromTokens = parsePointer(entry.op.from);
  if (fromTokens.length > 0) {
    runtime.state.exprGuards.push(buildPresenceGuardExpr(fromTokens));
  }

  return setAtPathFromFullDocument(runtime, entry.op.path)
    ? null
    : fallback(runtime.fullDocument, 'copy-target-not-found', runtime.cacheKey);
};

const compileMove = <TState>(runtime: PlannerRuntime<TState>, entry: PatchOperationEntry): MongoPatchFallbackPlan<TState> | null => {
  if (!entry.op.from) {
    throw new Error('RFC6902 move operation requires "from".');
  }

  const fromTokens = parsePointer(entry.op.from);
  if (
    fromTokens.length > 1 &&
    entry.tokens.length > 1 &&
    isNumericArrayIndex(fromTokens[fromTokens.length - 1] ?? '') &&
    isNumericArrayIndex(entry.tokens[entry.tokens.length - 1] ?? '')
  ) {
    const fromParent = parentTokens(fromTokens);
    const toParent = parentTokens(entry.tokens);
    if (fromParent.join('/') === toParent.join('/')) {
      const mongoPath = toMongoPath(fromParent);
      const parentRead = readAtTokens(runtime.fullDocument, fromParent);
      if (mongoPath && parentRead.found && Array.isArray(parentRead.value)) {
        runtime.state.set[mongoPath] = parentRead.value;
        return null;
      }
    }
  }

  if (!removeAtPath(runtime, entry.op.from) || !setAtPathFromFullDocument(runtime, entry.op.path)) {
    return fallback(runtime.fullDocument, 'move-not-compileable', runtime.cacheKey);
  }

  return null;
};

export const compileSafeOperation = <TState>(
  runtime: PlannerRuntime<TState>,
  entry: PatchOperationEntry
): MongoPatchFallbackPlan<TState> | null => {
  if (runtime.state.pipeline !== null && entry.op.op !== 'test') {
    return fallback(runtime.fullDocument, 'pipeline-mixed-with-follow-up-mutations', runtime.cacheKey);
  }

  if (entry.op.op === 'test') {
    return compileTestOperation(runtime, entry);
  }

  const rootResult = tryCompileDeterministicRootOp(runtime, entry);
  if (rootResult) {
    if (rootResult.mode === 'fallback-full-document') {
      return rootResult;
    }

    runtime.state.pipeline = rootResult.pipeline;
    runtime.state.testGuards.splice(0, runtime.state.testGuards.length, ...rootResult.testGuards);
    runtime.state.exprGuards.splice(0, runtime.state.exprGuards.length, ...rootResult.exprGuards);
    return null;
  }

  if (entry.op.op === 'remove') {
    return removeAtPath(runtime, entry.op.path)
      ? null
      : fallback(runtime.fullDocument, 'remove-not-compileable', runtime.cacheKey);
  }

  if (entry.op.op === 'replace' || entry.op.op === 'add') {
    return compileAddOrReplace(runtime, entry);
  }

  if (entry.op.op === 'copy') {
    return compileCopy(runtime, entry);
  }

  if (entry.op.op === 'move') {
    return compileMove(runtime, entry);
  }

  return fallback(runtime.fullDocument, 'unsupported-operation', runtime.cacheKey);
};
