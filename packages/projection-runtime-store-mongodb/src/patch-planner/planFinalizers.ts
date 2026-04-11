import { fallback } from './fallback';
import type { MongoPatchUpdatePlan, PlannerRuntime } from './types';

export const toCompiledDocumentPlan = <TState>(runtime: PlannerRuntime<TState>): MongoPatchUpdatePlan<TState> => ({
  mode: 'compiled-update-document',
  set: runtime.state.set,
  unset: [...runtime.state.unset.values()],
  push: runtime.state.push,
  pop: runtime.state.pop,
  testGuards: runtime.state.testGuards,
  exprGuards: runtime.state.exprGuards,
  cacheKey: runtime.cacheKey
});

export const toCompiledPipelinePlan = <TState>(runtime: PlannerRuntime<TState>): MongoPatchUpdatePlan<TState> => {
  const stage = runtime.state.pipeline?.[0];
  if (!stage || typeof stage !== 'object' || !('$set' in stage)) {
    return fallback(runtime.fullDocument, 'pipeline-stage-invalid', runtime.cacheKey);
  }

  const stageSet = (stage.$set as Record<string, unknown> | undefined) ?? {};
  return {
    mode: 'compiled-update-pipeline',
    pipeline: [{ $set: { ...stageSet } }],
    testGuards: runtime.state.testGuards,
    exprGuards: runtime.state.exprGuards,
    cacheKey: runtime.cacheKey
  };
};
