import type { ProjectionStoreRfc6902Operation } from './contracts';
import { makeCacheKey } from './patch-planner/cacheKey';
import { tryCompileMixedArraySet, tryCompileOrderedArraySet, tryCompileSimpleArrayReorder } from './patch-planner/compileFastPath';
import { compileSafeOperation } from './patch-planner/compileSafePath';
import { toCompiledDocumentPlan, toCompiledPipelinePlan } from './patch-planner/planFinalizers';
import { parsePointer } from './patch-planner/pointer';
import { shouldUseOrderedPipelineByScenario } from './patch-planner/scenarioMatrix';
import { compileOrderedPipelinePlan } from './patch-planner/compileOrderedPipelinePlan';
import type {
  MongoPatchUpdatePlan,
  MutableCompileState,
  PlannerRuntime
} from './patch-planner/types';

type PlannerOptions = {
  /** Only replace a whole array when the caller fences the state used to derive the final document. */
  coalesceGuardedArrayEdits?: boolean;
};

const createMutableState = (): MutableCompileState => ({
  set: {},
  unset: new Set<string>(),
  push: {},
  pop: {},
  testGuards: [],
  exprGuards: [],
  pipeline: null
});

const createRuntime = <TState>(
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>,
  fullDocument: TState
): PlannerRuntime<TState> => {
  const cacheKey = makeCacheKey(patch);
  const entries = patch.map((op) => ({
    op,
    tokens: parsePointer(op.path),
    fromTokens: 'from' in op && op.from ? parsePointer(op.from) : null
  }));

  return {
    cacheKey,
    fullDocument,
    entries,
    state: createMutableState()
  };
};

const compileWithFastPath = <TState>(runtime: PlannerRuntime<TState>, options?: PlannerOptions): MongoPatchUpdatePlan<TState> | null => {
  const reorderPlan = tryCompileSimpleArrayReorder(runtime);
  if (reorderPlan) {
    return reorderPlan;
  }

  const orderedArrayPlan = tryCompileOrderedArraySet(runtime);
  if (orderedArrayPlan) {
    return orderedArrayPlan;
  }

  return options?.coalesceGuardedArrayEdits ? tryCompileMixedArraySet(runtime) : null;
};

const compileWithOrderedOrSafePath = <TState>(runtime: PlannerRuntime<TState>): MongoPatchUpdatePlan<TState> => {
  if (shouldUseOrderedPipelineByScenario(runtime.entries)) {
    return compileOrderedPipelinePlan(runtime.entries, runtime.fullDocument, runtime.cacheKey);
  }

  for (const entry of runtime.entries) {
    const result = compileSafeOperation(runtime, entry);
    if (result) {
      return result;
    }
  }

  if (runtime.state.pipeline !== null) {
    return toCompiledPipelinePlan(runtime);
  }

  return toCompiledDocumentPlan(runtime);
};

export const patch6902ToMongoUpdatePlan = <TState>(
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>,
  fullDocument: TState,
  options?: PlannerOptions
): MongoPatchUpdatePlan<TState> => patch6902ToMongoUpdatePlanWithMetadata(patch, fullDocument, options);

export const patch6902ToMongoUpdatePlanWithMetadata = <TState>(
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>,
  fullDocument: TState,
  options?: PlannerOptions
): MongoPatchUpdatePlan<TState> => {
  const runtime = createRuntime(patch, fullDocument);
  const fastPath = compileWithFastPath(runtime, options);
  if (fastPath) {
    return fastPath;
  }

  return compileWithOrderedOrSafePath(runtime);
};

export type {
  MongoPatchTestGuard,
  MongoPatchCompiledPlan,
  MongoPatchFallbackPlan,
  MongoPatchUpdatePlan
} from './patch-planner/types';
