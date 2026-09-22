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
  ProjectionDefinitionCommitResult
} from './commitCoordinatorContracts';
import { executeProjectionDefinition } from './projectionDefinitionExecutor';
import { createProjectionLaneScheduler } from './targetLaneScheduler';

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

export function createProjectionCommitCoordinator<TState = unknown>(
  options: ProjectionCommitCoordinatorOptions<TState>
): ProjectionCommitCoordinator {
  assertOptions(options);
  const definitions = Object.freeze(options.definitions.map((entry) => Object.freeze({
    generation: entry.generation,
    definition: freezeDefinition(entry.definition)
  })));
  const sourceStartAnchors = Object.freeze({ ...options.manifest.sourceStartAnchors });
  const sourceLanes = createProjectionLaneScheduler();
  const targetLanes = createProjectionLaneScheduler();
  const maxGapPages = options.maxGapPages ?? DEFAULT_MAX_GAP_PAGES;
  const maxConflictRetries = options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;

  async function dispatch(commit: ProjectionSourceCommit): Promise<{
    outcome: ProjectionCommitCoordinatorOutcome;
    complete: boolean;
  }> {
    const results: ProjectionDefinitionCommitResult[] = [];
    for (const entry of definitions) {
      const outcome = await executeProjectionDefinition({
        definition: entry.definition,
        generation: entry.generation,
        store: options.store,
        lanes: targetLanes,
        maxConflictRetries
      }, commit);
      results.push({ projectionName: entry.definition.name, projectionGeneration: entry.generation, outcome });
      if (outcome.status === 'committed' || outcome.status === 'deduplicated') continue;
      return {
        complete: false,
        outcome: failureOutcome('reason' in outcome ? outcome.reason : 'Definition did not complete.', [], results, outcome.status === 'terminal')
      };
    }
    return { complete: true, outcome: { status: 'completed', processedSequences: [], definitions: results } };
  }

  async function processInSourceLane(commit: ProjectionSourceCommit): Promise<ProjectionCommitCoordinatorOutcome> {
    let admission;
    try {
      admission = await options.sourceOrder.admitForDispatch(commit, options.queueBindingId);
    } catch (error) {
      return failureOutcome(error instanceof Error ? error.message : 'Source admission unavailable.', [], []);
    }
    if (admission.coverage.sourceId !== commit.streamId || admission.coverage.queueBindingId !== options.queueBindingId) {
      return failureOutcome('Source order port returned mismatched coverage.', [], [], true);
    }
    const coverage = admission.coverage.sequence;
    const startAnchor = sourceStartAnchors[commit.streamId] ?? 0;
    if (coverage === null && commit.commitSequence < startAnchor) {
      return failureOutcome('Commit precedes immutable source start anchor.', [], [], true);
    }
    const recovered: ProjectionSourceCommit[] = [];
    let after = coverage ?? (startAnchor === 0 ? null : startAnchor - 1);
    if (commit.commitSequence > (after ?? -1) + 1) {
      for (let page = 0; page < maxGapPages && (after ?? -1) < commit.commitSequence - 1; page += 1) {
        const request = {
          sourceId: commit.streamId, afterSequence: after, throughSequence: commit.commitSequence - 1,
          maxCommits: options.maxCommits, maxBytes: options.maxBytes
        };
        let range;
        try {
          range = await options.rangeReader.readCompleteRange(request);
        } catch (error) {
          return failureOutcome(error instanceof Error ? error.message : 'Complete commit gap unavailable.', [], []);
        }
        const validation = validateCompleteCommitRange(request, range);
        if (!validation.valid || range.status !== 'complete') {
          return failureOutcome(`Complete commit gap unavailable: ${validation.issues.join(',')}`, [], []);
        }
        recovered.push(...range.commits.map((entry) => entry.commit));
        after = range.continuationAfterSequence;
      }
      if ((after ?? -1) < commit.commitSequence - 1) return failureOutcome('Complete commit gap exceeded bounded page limit.', [], []);
    }
    const processed: number[] = [];
    const allResults: ProjectionDefinitionCommitResult[] = [];
    let expectedCoverage = coverage;
    for (const candidate of [...recovered, commit]) {
      const dispatched = await dispatch(candidate);
      allResults.push(...dispatched.outcome.definitions);
      if (!dispatched.complete) return { ...dispatched.outcome, processedSequences: processed, definitions: allResults };
      processed.push(candidate.commitSequence);
      if (candidate.commitSequence > (expectedCoverage ?? -1)) {
        try {
          const advanced = await options.sourceOrder.advanceCoverage({
            queueBindingId: options.queueBindingId,
            sourceId: commit.streamId,
            expectedSequence: expectedCoverage,
            sequence: candidate.commitSequence
          });
          if (advanced.queueBindingId !== options.queueBindingId
            || advanced.sourceId !== commit.streamId
            || advanced.sequence !== candidate.commitSequence) {
            return failureOutcome('Source order port returned mismatched advanced coverage.', processed, allResults, true);
          }
          expectedCoverage = advanced.sequence;
        } catch (error) {
          return failureOutcome(error instanceof Error ? error.message : 'Coverage outcome unknown.', processed, allResults);
        }
      }
    }
    return { status: 'completed', processedSequences: processed, definitions: allResults };
  }

  return {
    process(commit) {
      const validation = validateProjectionSourceCommit(commit);
      if (!validation.valid) return Promise.resolve(failureOutcome(`Invalid source commit: ${validation.issues.join(',')}`, [], [], true));
      return sourceLanes.run([commit.streamId], () => processInSourceLane(commit));
    }
  };
}
