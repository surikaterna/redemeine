import type { PatchOperationEntry, MongoPatchUpdatePlan } from './types';
import { fallback } from './fallback';
import { isArrayIndexLike } from './pointer';
import { readAtTokens } from './stateReader';
import {
  buildPresenceGuardExpr,
  buildStrictEqualityExpr,
  buildUnsafeReadExpr,
  setUnsafeAtTokensExpr,
  unsetUnsafeAtTokensExpr
} from './exprBuilders';

const isMutation = (op: string): boolean => op !== 'test';

const buildPresenceGuard = (tokens: readonly string[]): Record<string, unknown> => {
  return {
    $ne: [{ $type: buildUnsafeReadExpr(tokens) }, 'missing']
  };
};

const shouldReplaceWholeState = (entry: PatchOperationEntry): boolean => {
  if (!isMutation(entry.op.op)) {
    return false;
  }

  if (entry.tokens.length === 0) {
    return true;
  }

  if (entry.tokens.some((token) => isArrayIndexLike(token))) {
    return true;
  }

  if (entry.fromTokens?.some((token) => isArrayIndexLike(token))) {
    return true;
  }

  return entry.op.op === 'copy' || entry.op.op === 'move';
};

const wholeStateReplacementValue = <TState>(entry: PatchOperationEntry, fullDocument: TState): unknown => {
  return entry.op.op === 'remove' && entry.tokens.length === 0 ? null : fullDocument;
};

const appendOperationGuards = (entry: PatchOperationEntry, guards: Array<Record<string, unknown>>): void => {
  if (entry.op.op === 'test') {
    guards.push(entry.tokens.length === 0 ? buildStrictEqualityExpr([], entry.op.value) : { $eq: [buildUnsafeReadExpr(entry.tokens), entry.op.value] });
    return;
  }

  if (entry.op.op === 'remove' || entry.op.op === 'replace') {
    if (entry.tokens.length > 0) {
      guards.push(buildPresenceGuard(entry.tokens));
    }
  }

  if ((entry.op.op === 'copy' || entry.op.op === 'move') && entry.fromTokens && entry.fromTokens.length > 0) {
    guards.push(buildPresenceGuardExpr(entry.fromTokens));
  }
};

const applyOrderedMutation = <TState>(
  entry: PatchOperationEntry,
  fullDocument: TState,
  stateExpr: unknown
): { nextStateExpr: unknown; shouldReplaceWholeState: boolean; replacementStateExpr?: unknown; fallbackReason?: string } => {
  if (shouldReplaceWholeState(entry)) {
    return {
      nextStateExpr: stateExpr,
      shouldReplaceWholeState: true,
      replacementStateExpr: wholeStateReplacementValue(entry, fullDocument)
    };
  }

  if (entry.op.op === 'remove') {
    return { nextStateExpr: unsetUnsafeAtTokensExpr(stateExpr, entry.tokens), shouldReplaceWholeState: false };
  }

  if (entry.op.op === 'add' || entry.op.op === 'replace') {
    const valueRead = readAtTokens(fullDocument, entry.tokens);
    if (!valueRead.found) {
      return {
        nextStateExpr: stateExpr,
        shouldReplaceWholeState: false,
        fallbackReason: 'ordered-pipeline-target-not-found-in-full-document'
      };
    }

    return {
      nextStateExpr: setUnsafeAtTokensExpr(stateExpr, entry.tokens, valueRead.value),
      shouldReplaceWholeState: false
    };
  }

  if (entry.op.op !== 'copy' && entry.op.op !== 'move') {
    return { nextStateExpr: stateExpr, shouldReplaceWholeState: false, fallbackReason: 'unsupported-operation' };
  }

  return { nextStateExpr: stateExpr, shouldReplaceWholeState: false };
};

export const compileOrderedPipelinePlan = <TState>(
  entries: ReadonlyArray<PatchOperationEntry>,
  fullDocument: TState,
  cacheKey: string
): MongoPatchUpdatePlan<TState> => {
  const exprGuards: Array<Record<string, unknown>> = [];
  let stateExpr: unknown = '$state';
  let replaceWholeState = false;
  let replacementStateExpr: unknown = fullDocument;

  for (const entry of entries) {
    appendOperationGuards(entry, exprGuards);
    if (replaceWholeState || !isMutation(entry.op.op)) {
      continue;
    }

    const mutationResult = applyOrderedMutation(entry, fullDocument, stateExpr);
    if (mutationResult.fallbackReason) {
      return fallback(fullDocument, mutationResult.fallbackReason, cacheKey);
    }

    if (mutationResult.shouldReplaceWholeState) {
      replaceWholeState = true;
      replacementStateExpr = mutationResult.replacementStateExpr;
      continue;
    }

    stateExpr = mutationResult.nextStateExpr;
  }

  return {
    mode: 'compiled-update-pipeline',
    pipeline: [
      {
        $set: {
          state: replaceWholeState ? replacementStateExpr : stateExpr
        }
      }
    ],
    testGuards: [],
    exprGuards,
    cacheKey
  };
};
