import { fallback } from './fallback';
import { buildStrictEqualityExpr } from './exprBuilders';
import type {
  MongoPatchCompiledUpdatePipelinePlan,
  MongoPatchFallbackPlan,
  PatchOperationEntry,
  PlannerRuntime
} from './types';

const hasNonTestCompanionMutation = <TState>(runtime: PlannerRuntime<TState>, entry: PatchOperationEntry): boolean => {
  return runtime.entries.some((candidate) => candidate.op.op !== 'test' && candidate !== entry);
};

export const tryCompileDeterministicRootOp = <TState>(
  runtime: PlannerRuntime<TState>,
  entry: PatchOperationEntry
): MongoPatchCompiledUpdatePipelinePlan | MongoPatchFallbackPlan<TState> | null => {
  const { cacheKey, fullDocument, state } = runtime;
  if (entry.tokens.length !== 0) {
    return null;
  }

  if (entry.op.op === 'test') {
    state.exprGuards.push(buildStrictEqualityExpr([], entry.op.value));
    return null;
  }

  if (hasNonTestCompanionMutation(runtime, entry)) {
    return fallback(fullDocument, 'op-root-path-mixed-with-other-mutations', cacheKey);
  }

  if (['add', 'replace', 'remove', 'copy', 'move'].includes(entry.op.op)) {
    return {
      mode: 'compiled-update-pipeline',
      pipeline: [{ $set: { state: entry.op.op === 'remove' ? null : fullDocument } }],
      testGuards: state.testGuards,
      exprGuards: state.exprGuards,
      cacheKey
    };
  }

  return fallback(fullDocument, 'unsupported-operation', cacheKey);
};
