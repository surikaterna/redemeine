import { hasUnsafeToken } from './mongoPath';
import { isArrayIndexLike } from './pointer';
import type { PatchOperationEntry } from './types';

const hasRootMutation = (entries: ReadonlyArray<PatchOperationEntry>): boolean => {
  return entries.some((entry) => entry.tokens.length === 0 && entry.op.op !== 'test');
};

const hasUnsafeAndSafeMix = (entries: ReadonlyArray<PatchOperationEntry>): boolean => {
  const flags = entries.map((entry) => hasUnsafeToken(entry.tokens) || (entry.fromTokens ? hasUnsafeToken(entry.fromTokens) : false));
  return flags.some(Boolean) && flags.some((flag) => !flag);
};

const hasAnyUnsafePath = (entries: ReadonlyArray<PatchOperationEntry>): boolean => {
  return entries.some((entry) => hasUnsafeToken(entry.tokens) || (entry.fromTokens ? hasUnsafeToken(entry.fromTokens) : false));
};

const hasMixedArrayAndObjectMutations = (entries: ReadonlyArray<PatchOperationEntry>): boolean => {
  let hasArrayTarget = false;
  let hasObjectTarget = false;

  for (const entry of entries) {
    if (entry.op.op === 'test') {
      continue;
    }

    const leaf = entry.tokens[entry.tokens.length - 1] ?? '';
    if (isArrayIndexLike(leaf)) {
      hasArrayTarget = true;
    } else {
      hasObjectTarget = true;
    }

    if (hasArrayTarget && hasObjectTarget) {
      return true;
    }
  }

  return false;
};

export const shouldUseOrderedPipelineByScenario = (entries: ReadonlyArray<PatchOperationEntry>): boolean => {
  if (entries.length === 0) {
    return false;
  }

  if (hasRootMutation(entries)) {
    return true;
  }

  if (hasUnsafeAndSafeMix(entries)) {
    return true;
  }

  if (hasAnyUnsafePath(entries)) {
    return true;
  }

  if (entries.length >= 4 && hasMixedArrayAndObjectMutations(entries)) {
    return true;
  }

  return false;
};
