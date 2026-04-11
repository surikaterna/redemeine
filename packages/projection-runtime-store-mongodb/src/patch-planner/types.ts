import type { ProjectionStoreRfc6902Operation } from '../contracts';

export type MongoScalarPath = string;

export type MongoPatchTestGuard = { path: MongoScalarPath; value: unknown };

type MongoPatchBaseCompiledPlan = {
  testGuards: ReadonlyArray<MongoPatchTestGuard>;
  exprGuards: ReadonlyArray<Record<string, unknown>>;
  cacheKey: string;
};

export type MongoPatchCompiledUpdateDocumentPlan = MongoPatchBaseCompiledPlan & {
  mode: 'compiled-update-document';
  set: Readonly<Record<MongoScalarPath, unknown>>;
  unset: ReadonlyArray<MongoScalarPath>;
  push: Readonly<Record<MongoScalarPath, unknown>>;
  pop: Readonly<Record<MongoScalarPath, 1 | -1>>;
};

export type MongoPatchCompiledUpdatePipelinePlan = MongoPatchBaseCompiledPlan & {
  mode: 'compiled-update-pipeline';
  pipeline: ReadonlyArray<Record<string, unknown>>;
};

export type MongoPatchFallbackPlan<TState> = {
  mode: 'fallback-full-document';
  fullDocument: TState;
  fallbackReason: string;
  cacheKey: string;
};

export type MongoPatchCompiledPlan = MongoPatchCompiledUpdateDocumentPlan | MongoPatchCompiledUpdatePipelinePlan;

export type MongoPatchUpdatePlan<TState> = MongoPatchCompiledPlan | MongoPatchFallbackPlan<TState>;

export type PatchOperationEntry = {
  op: ProjectionStoreRfc6902Operation;
  tokens: string[];
  fromTokens: string[] | null;
};

export type MutableCompileState = {
  set: Record<string, unknown>;
  unset: Set<string>;
  push: Record<string, unknown>;
  pop: Record<string, 1 | -1>;
  testGuards: Array<MongoPatchTestGuard>;
  exprGuards: Array<Record<string, unknown>>;
  pipeline: ReadonlyArray<Record<string, unknown>> | null;
};

export type PlannerRuntime<TState> = {
  cacheKey: string;
  fullDocument: TState;
  entries: Array<PatchOperationEntry>;
  state: MutableCompileState;
};
