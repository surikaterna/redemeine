import {
  isCompleteCommitRangeCapability,
  validateCompleteCommitRange,
  validateProjectionQueueRegistryManifest,
  validateProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import type { ProjectionCommitDefinition, ProjectionSourceCommit } from '@redemeine/projection-runtime-core';
import type {
  ProjectionCommitCoordinator,
  ProjectionCommitCoordinatorOptions,
  ProjectionCommitCoordinatorOutcome,
  ProjectionCommitRegistryDefinition,
  ProjectionDefinitionCommitResult
} from './commitCoordinatorContracts';
import { executeProjectionDefinition } from './projectionDefinitionExecutor';
import { createProjectionLaneScheduler, type ProjectionLaneScheduler } from './targetLaneScheduler';

const DEFAULT_MAX_GAP_PAGES = 1_000;
const DEFAULT_MAX_CONFLICT_RETRIES = 3;

function assertOptions<TState>(options: ProjectionCommitCoordinatorOptions<TState>): void {
  const manifestIssues = validateProjectionQueueRegistryManifest(options.manifest);
  if (manifestIssues.length > 0) throw new Error(`Invalid registry manifest: ${manifestIssues.join(',')}`);
  if (!isCompleteCommitRangeCapability(options.rangeReader.capability)) throw new Error('Complete unsliced commit range capability is required.');
  if (!Number.isSafeInteger(options.maxCommits) || options.maxCommits <= 0) throw new Error('maxCommits must be a positive safe integer.');
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer.');
  if (options.maxGapPages !== undefined && (!Number.isSafeInteger(options.maxGapPages) || options.maxGapPages <= 0)) {
    throw new Error('maxGapPages must be a positive safe integer.');
  }
  if (options.maxConflictRetries !== undefined
    && (!Number.isSafeInteger(options.maxConflictRetries) || options.maxConflictRetries < 0)) {
    throw new Error('maxConflictRetries must be a nonnegative safe integer.');
  }
  if (options.manifest.queueId !== options.queueBindingId) throw new Error('Registry manifest queue does not match queue binding.');
  if (options.manifest.definitions.length !== options.definitions.length) throw new Error('Runtime registry must exactly match the immutable manifest.');
  for (const [index, entry] of options.definitions.entries()) {
    const manifest = options.manifest.definitions[index];
    if (!manifest || manifest.projectionName !== entry.definition.name || manifest.generation !== entry.generation) {
      throw new Error('Runtime registry order and scopes must exactly match the immutable manifest.');
    }
  }
}

function failureOutcome(
  reason: string,
  processedSequences: readonly number[],
  definitions: readonly ProjectionDefinitionCommitResult[],
  terminal = false
): ProjectionCommitCoordinatorOutcome {
  return { status: terminal ? 'terminal' : 'retryable', reason, processedSequences, definitions };
}

function freezeDefinition<TState>(definition: ProjectionCommitDefinition<TState>): ProjectionCommitDefinition<TState> {
  const copyStream = <T extends { aggregate: object; handlers: Record<string, unknown> }>(stream: T): T => {
    const copy = { ...stream, aggregate: Object.freeze({ ...stream.aggregate }), handlers: { ...stream.handlers } };
    Object.freeze(copy.handlers);
    return Object.freeze(copy);
  };
  const joinStreams = (definition.joinStreams ?? []).map(copyStream);
  const reverseSubscribeStreams = (definition.reverseSubscribeStreams ?? []).map(copyStream);
  const subscriptions = [...definition.subscriptions];
  Object.freeze(joinStreams);
  Object.freeze(reverseSubscribeStreams);
  Object.freeze(subscriptions);
  const deduplication = {
    ...definition.deduplication,
    ...('warnings' in definition.deduplication && definition.deduplication.warnings
      ? { warnings: Object.freeze({ ...definition.deduplication.warnings }) }
      : {})
  };
  const copy: ProjectionCommitDefinition<TState> = {
    ...definition,
    fromStream: copyStream(definition.fromStream),
    joinStreams,
    reverseSubscribeStreams,
    subscriptions,
    deduplication: Object.freeze(deduplication),
    ...(definition.hooks ? { hooks: Object.freeze({ ...definition.hooks }) } : {})
  };
  return Object.freeze(copy);
}

interface CoordinatorRuntime<TState> {
  options: ProjectionCommitCoordinatorOptions<TState>;
  definitions: readonly ProjectionCommitRegistryDefinition<TState>[];
  sourceStartAnchors: Readonly<Record<string, number>>;
  sourceLanes: ProjectionLaneScheduler;
  targetLanes: ProjectionLaneScheduler;
  maxGapPages: number;
  maxConflictRetries: number;
}

type GapResult =
  | { status: 'recovered'; commits: readonly ProjectionSourceCommit[] }
  | { status: 'failed'; outcome: ProjectionCommitCoordinatorOutcome };

async function dispatch<TState>(runtime: CoordinatorRuntime<TState>, commit: ProjectionSourceCommit): Promise<{
  outcome: ProjectionCommitCoordinatorOutcome;
  complete: boolean;
}> {
  const results: ProjectionDefinitionCommitResult[] = [];
  for (const entry of runtime.definitions) {
    const outcome = await executeProjectionDefinition({
      definition: entry.definition, generation: entry.generation, store: runtime.options.store,
      lanes: runtime.targetLanes, maxConflictRetries: runtime.maxConflictRetries
    }, commit);
    results.push({ projectionName: entry.definition.name, projectionGeneration: entry.generation, outcome });
    if (outcome.status === 'committed' || outcome.status === 'deduplicated') continue;
    const reason = 'reason' in outcome ? outcome.reason : 'Definition did not complete.';
    return { complete: false, outcome: failureOutcome(reason, [], results, outcome.status === 'terminal') };
  }
  return { complete: true, outcome: { status: 'completed', processedSequences: [], definitions: results } };
}

async function readGap<TState>(
  runtime: CoordinatorRuntime<TState>,
  commit: ProjectionSourceCommit,
  initialAfter: number | null
): Promise<GapResult> {
  const recovered: ProjectionSourceCommit[] = [];
  let after = initialAfter;
  for (let page = 0; page < runtime.maxGapPages && (after ?? -1) < commit.commitSequence - 1; page += 1) {
    const request = {
      sourceId: commit.streamId, afterSequence: after, throughSequence: commit.commitSequence - 1,
      maxCommits: runtime.options.maxCommits, maxBytes: runtime.options.maxBytes
    };
    let range;
    try {
      range = await runtime.options.rangeReader.readCompleteRange(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Complete commit gap unavailable.';
      return { status: 'failed', outcome: failureOutcome(reason, [], []) };
    }
    const validation = validateCompleteCommitRange(request, range);
    if (!validation.valid || range.status !== 'complete') {
      const reason = `Complete commit gap unavailable: ${validation.issues.join(',')}`;
      return { status: 'failed', outcome: failureOutcome(reason, [], []) };
    }
    recovered.push(...range.commits.map((entry) => entry.commit));
    after = range.continuationAfterSequence;
  }
  if ((after ?? -1) < commit.commitSequence - 1) {
    return { status: 'failed', outcome: failureOutcome('Complete commit gap exceeded bounded page limit.', [], []) };
  }
  return { status: 'recovered', commits: recovered };
}

async function advanceCoverage<TState>(
  runtime: CoordinatorRuntime<TState>,
  sourceCommit: ProjectionSourceCommit,
  candidate: ProjectionSourceCommit,
  expectedSequence: number | null,
  processed: readonly number[],
  results: readonly ProjectionDefinitionCommitResult[]
): Promise<number | ProjectionCommitCoordinatorOutcome> {
  try {
    const advanced = await runtime.options.sourceOrder.advanceCoverage({
      queueBindingId: runtime.options.queueBindingId, sourceId: sourceCommit.streamId,
      expectedSequence, sequence: candidate.commitSequence
    });
    if (advanced.queueBindingId !== runtime.options.queueBindingId
      || advanced.sourceId !== sourceCommit.streamId
      || advanced.sequence !== candidate.commitSequence) {
      return failureOutcome('Source order port returned mismatched advanced coverage.', processed, results, true);
    }
    return advanced.sequence;
  } catch (error) {
    return failureOutcome(error instanceof Error ? error.message : 'Coverage outcome unknown.', processed, results);
  }
}

async function processCandidates<TState>(
  runtime: CoordinatorRuntime<TState>,
  sourceCommit: ProjectionSourceCommit,
  candidates: readonly ProjectionSourceCommit[],
  initialCoverage: number | null
): Promise<ProjectionCommitCoordinatorOutcome> {
  const processed: number[] = [];
  const allResults: ProjectionDefinitionCommitResult[] = [];
  let expectedCoverage = initialCoverage;
  for (const candidate of candidates) {
    const dispatched = await dispatch(runtime, candidate);
    allResults.push(...dispatched.outcome.definitions);
    if (!dispatched.complete) return { ...dispatched.outcome, processedSequences: processed, definitions: allResults };
    processed.push(candidate.commitSequence);
    if (candidate.commitSequence <= (expectedCoverage ?? -1)) continue;
    const advanced = await advanceCoverage(runtime, sourceCommit, candidate, expectedCoverage, processed, allResults);
    if (typeof advanced !== 'number') return advanced;
    expectedCoverage = advanced;
  }
  return { status: 'completed', processedSequences: processed, definitions: allResults };
}

async function processInSourceLane<TState>(
  runtime: CoordinatorRuntime<TState>,
  commit: ProjectionSourceCommit
): Promise<ProjectionCommitCoordinatorOutcome> {
  let admission;
  try {
    admission = await runtime.options.sourceOrder.admitForDispatch(commit, runtime.options.queueBindingId);
  } catch (error) {
    return failureOutcome(error instanceof Error ? error.message : 'Source admission unavailable.', [], []);
  }
  if (admission.coverage.sourceId !== commit.streamId
    || admission.coverage.queueBindingId !== runtime.options.queueBindingId) {
    return failureOutcome('Source order port returned mismatched coverage.', [], [], true);
  }
  const coverage = admission.coverage.sequence;
  const startAnchor = runtime.sourceStartAnchors[commit.streamId] ?? 0;
  if (coverage === null && commit.commitSequence < startAnchor) {
    return failureOutcome('Commit precedes immutable source start anchor.', [], [], true);
  }
  const after = coverage ?? (startAnchor === 0 ? null : startAnchor - 1);
  if (commit.commitSequence <= (after ?? -1) + 1) return processCandidates(runtime, commit, [commit], coverage);
  const recovered = await readGap(runtime, commit, after);
  if (recovered.status === 'failed') return recovered.outcome;
  return processCandidates(runtime, commit, [...recovered.commits, commit], coverage);
}

function createRuntime<TState>(options: ProjectionCommitCoordinatorOptions<TState>): CoordinatorRuntime<TState> {
  const definitions = options.definitions.map((entry) => Object.freeze({
    generation: entry.generation,
    definition: freezeDefinition(entry.definition)
  }));
  return {
    options,
    definitions: Object.freeze(definitions),
    sourceStartAnchors: Object.freeze({ ...options.manifest.sourceStartAnchors }),
    sourceLanes: createProjectionLaneScheduler(),
    targetLanes: createProjectionLaneScheduler(),
    maxGapPages: options.maxGapPages ?? DEFAULT_MAX_GAP_PAGES,
    maxConflictRetries: options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES
  };
}

export function createProjectionCommitCoordinator<TState = unknown>(
  options: ProjectionCommitCoordinatorOptions<TState>
): ProjectionCommitCoordinator {
  assertOptions(options);
  const runtime = createRuntime(options);
  return {
    process(commit) {
      const validation = validateProjectionSourceCommit(commit);
      if (!validation.valid) {
        const outcome = failureOutcome(`Invalid source commit: ${validation.issues.join(',')}`, [], [], true);
        return Promise.resolve(outcome);
      }
      return runtime.sourceLanes.run([commit.streamId], () => processInSourceLane(runtime, commit));
    }
  };
}
