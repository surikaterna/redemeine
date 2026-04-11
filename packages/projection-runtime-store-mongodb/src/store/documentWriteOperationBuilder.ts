import type { AnyBulkWriteOperation } from 'mongodb';
import { ProjectionStoreAtomicManyError, createInvalidRequestFailure } from '../storeFailures';
import { patch6902ToMongoUpdatePlan } from '../patch6902ToMongoUpdatePlan';
import type { Checkpoint, ProjectionStoreCommitAtomicManyRequest } from '../contracts';
import type {
  MongoPatchPlanMode,
  MongoPatchPlanTelemetryEvent,
  ProjectionDocumentRecord
} from '../types';

type PatchCacheValue = { mode: MongoPatchPlanMode; fallbackReason?: string };

const withPlanCache = (
  cache: Map<string, PatchCacheValue>,
  maxEntries: number,
  cacheKey: string,
  value: PatchCacheValue
): boolean => {
  const cacheHit = cache.has(cacheKey);
  if (cacheHit) {
    cache.delete(cacheKey);
  }

  cache.set(cacheKey, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }

    cache.delete(oldest.value);
  }

  return cacheHit;
};

const buildFilter = (
  documentId: string,
  testGuards: ReadonlyArray<{ path: string; value: unknown }>,
  exprGuards: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> => {
  const filter: Record<string, unknown> = { _id: documentId };
  for (const guard of testGuards) {
    filter[`state.${guard.path}`] = guard.value;
  }

  if (exprGuards.length > 0) {
    filter.$expr = exprGuards.length === 1 ? exprGuards[0] : { $and: exprGuards };
  }

  return filter;
};

const buildDocumentUpdateFromCompiled = (
  checkpoint: Checkpoint,
  now: () => string,
  plan: Extract<ReturnType<typeof patch6902ToMongoUpdatePlan>, { mode: 'compiled-update-document' }>
): Record<string, unknown> => {
  const setDoc: Record<string, unknown> = {
    checkpoint,
    updatedAt: now()
  };

  for (const [path, value] of Object.entries(plan.set)) {
    setDoc[`state.${path}`] = value;
  }

  const updateDoc: Record<string, unknown> = { $set: setDoc };
  if (plan.unset.length > 0) {
    updateDoc.$unset = Object.fromEntries(plan.unset.map((path) => [`state.${path}`, '']));
  }

  if (Object.keys(plan.push).length > 0) {
    updateDoc.$push = Object.fromEntries(Object.entries(plan.push).map(([path, value]) => [`state.${path}`, value]));
  }

  if (Object.keys(plan.pop).length > 0) {
    updateDoc.$pop = Object.fromEntries(Object.entries(plan.pop).map(([path, value]) => [`state.${path}`, value]));
  }

  return updateDoc;
};

const buildPipelineUpdate = (
  checkpoint: Checkpoint,
  now: () => string,
  plan: Extract<ReturnType<typeof patch6902ToMongoUpdatePlan>, { mode: 'compiled-update-pipeline' }>
): ReadonlyArray<Record<string, unknown>> => {
  return plan.pipeline.map((stage) => {
    if (!stage.$set || typeof stage.$set !== 'object') {
      return stage;
    }

    return {
      ...stage,
      $set: {
        ...stage.$set,
        checkpoint,
        updatedAt: now()
      }
    };
  });
};

const buildFullWriteOperation = <TState>(
  documentId: string,
  fullDocument: TState,
  checkpoint: Checkpoint,
  now: () => string
): AnyBulkWriteOperation<ProjectionDocumentRecord<TState>> => {
  return {
    updateOne: {
      filter: { _id: documentId },
      update: {
        $set: {
          state: fullDocument,
          checkpoint,
          updatedAt: now()
        }
      },
      upsert: true
    }
  };
};

const buildPlannedWriteOperation = <TState>(
  write: ProjectionStoreCommitAtomicManyRequest<TState>['writes'][number]['documents'][number],
  now: () => string,
  plan: Extract<ReturnType<typeof patch6902ToMongoUpdatePlan>, { mode: 'compiled-update-document' | 'compiled-update-pipeline' }>
): AnyBulkWriteOperation<ProjectionDocumentRecord<TState>> => {
  const filter = buildFilter(write.documentId, plan.testGuards, plan.exprGuards);
  if (plan.mode === 'compiled-update-pipeline') {
    return {
      updateOne: {
        filter,
        update: buildPipelineUpdate(write.checkpoint, now, plan),
        upsert: true
      }
    };
  }

  return {
    updateOne: {
      filter,
      update: buildDocumentUpdateFromCompiled(write.checkpoint, now, plan),
      upsert: true
    }
  };
};

export type DocumentWriteOperationBuilderInput<TState> = {
  write: ProjectionStoreCommitAtomicManyRequest<TState>['writes'][number]['documents'][number];
  now: () => string;
  patchPlanCache: Map<string, PatchCacheValue>;
  patchPlanCacheMaxEntries: number;
  patchPlanTelemetry?: (event: MongoPatchPlanTelemetryEvent) => void;
};

export const buildDocumentWriteOperation = <TState>(
  input: DocumentWriteOperationBuilderInput<TState>
): AnyBulkWriteOperation<ProjectionDocumentRecord<TState>> => {
  const { write, now, patchPlanCache, patchPlanCacheMaxEntries, patchPlanTelemetry } = input;

  if (write.mode === 'full') {
    return buildFullWriteOperation(write.documentId, write.fullDocument, write.checkpoint, now);
  }

  let plan;
  try {
    plan = patch6902ToMongoUpdatePlan(write.patch, write.fullDocument);
  } catch (error) {
    throw new ProjectionStoreAtomicManyError(
      createInvalidRequestFailure(error instanceof Error ? error.message : 'invalid patch request')
    );
  }

  const cacheHit = withPlanCache(patchPlanCache, patchPlanCacheMaxEntries, plan.cacheKey, {
    mode: plan.mode,
    fallbackReason: plan.mode === 'fallback-full-document' ? plan.fallbackReason : undefined
  });

  patchPlanTelemetry?.({
    documentId: write.documentId,
    mode: plan.mode,
    fallbackReason: plan.mode === 'fallback-full-document' ? plan.fallbackReason : undefined,
    cacheKey: plan.cacheKey,
    cacheHit,
    patchLength: write.patch.length
  });

  if (plan.mode === 'fallback-full-document') {
    return buildFullWriteOperation(write.documentId, plan.fullDocument, write.checkpoint, now);
  }

  return buildPlannedWriteOperation(write, now, plan);
};
