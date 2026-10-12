import {
  sameLiveFloor, validateCompleteCommitRange, validateProjectionSourceCommit,
  type LiveCommitCoordinator, type LiveCommitResult, type LiveSourceOrderPort, type LiveSourcePosition,
  type LiveWorkBudget, type ProjectionCompleteCommitRangeReader, type ProjectionSourceCommit,
  type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import type { ProjectionCommitRegistryDefinition } from './commitCoordinatorContracts';
import { executeProjectionDefinition } from './projectionDefinitionExecutor';
import { createProjectionLaneScheduler } from './targetLaneScheduler';
import { assertLiveRouting, snapshotLiveDefinition } from './liveExecutionGuard';

export interface LiveCommitCoordinatorOptions<TState> {
  readonly epoch: string;
  readonly registryDigest: string;
  readonly definitions: readonly ProjectionCommitRegistryDefinition<TState>[];
  readonly store: ProjectionSourceCommitStorePort<TState>;
  readonly sourceOrder: LiveSourceOrderPort;
  readonly rangeReader: ProjectionCompleteCommitRangeReader;
  readonly budget: LiveWorkBudget;
  readonly now?: () => number;
}

function assertOptions<TState>(options: LiveCommitCoordinatorOptions<TState>): void {
  if (!options.epoch || options.epoch.length > 512 || !options.registryDigest || options.registryDigest.length > 512
    || options.definitions.length === 0 || options.definitions.length > 128) {
    throw new Error('invalid_live_registry');
  }
  const names = new Set(options.definitions.map(({ definition }) => definition.name));
  if (names.size !== options.definitions.length) throw new Error('live_registry_collision');
  for (const { definition, generation } of options.definitions) {
    if (generation !== options.definitions[0]?.generation) throw new Error('unsupported_start_mode');
    if (!definition.name || definition.name.length > 256 || generation.length > 256) throw new Error('invalid_live_registry');
    if (!generation) throw new Error('unsupported_start_mode');
    assertLiveRouting(definition);
    if (definition.deduplication.strategy === 'none') throw new Error('unsupported_live_deduplication');
  }
  const { maxCommits, maxBytes, maxMilliseconds, maxEventsPerCommit } = options.budget;
  for (const limit of [maxCommits, maxBytes, maxMilliseconds, maxEventsPerCommit]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid_live_budget');
  }
}

function validateIncoming(commit: ProjectionSourceCommit, position: LiveSourcePosition): void {
  if (!validateProjectionSourceCommit(commit).valid || commit.streamId !== position.sourceId
    || commit.commitSequence < position.firstSequence
    || (commit.commitSequence === position.firstSequence && commit.commitId !== position.firstCommitId)) {
    throw new Error('live_continuity_violation');
  }
}

function nextSequence(position: LiveSourcePosition): number {
  return position.coveredThrough === null ? position.firstSequence : position.coveredThrough + 1;
}

function pauseReason(error: unknown): string {
  const allowed = ['live_continuity_violation', 'live_work_capacity', 'live_payload_capacity', 'live_history_unavailable',
    'live_position_identity_conflict', 'unsupported_live_routing', 'marker_lifetime_violation', 'live_definition_failed'];
  return error instanceof Error && allowed.includes(error.message) ? error.message : 'live_turn_refused';
}

/** One active source turn; neither source inventory nor per-commit result arrays are retained. */
class LiveCoordinator<TState> implements LiveCommitCoordinator {
  readonly epoch: string;
  readonly registryDigest: string;
  readonly generation: string;
  private readonly lanes = createProjectionLaneScheduler();
  private readonly now: () => number;
  private active = false;
  private readonly options: LiveCommitCoordinatorOptions<TState>;

  constructor(options: LiveCommitCoordinatorOptions<TState>) {
    assertOptions(options);
    this.options = { ...options, budget: { ...options.budget }, definitions: options.definitions.map((entry) => ({
      generation: entry.generation, definition: snapshotLiveDefinition(entry.definition)
    })) };
    this.epoch = options.epoch;
    this.registryDigest = options.registryDigest;
    this.generation = options.definitions[0]?.generation ?? '';
    this.now = options.now ?? Date.now;
  }

  private async dispatch(commit: ProjectionSourceCommit, position: LiveSourcePosition, assertCurrent: () => void): Promise<void> {
    const options = this.options;
    assertCurrent();
    if (commit.events.length > options.budget.maxEventsPerCommit) throw new Error('live_work_capacity');
    for (const entry of options.definitions) {
      assertCurrent();
      const outcome = await executeProjectionDefinition({ ...entry, store: options.store, lanes: this.lanes, maxConflictRetries: 2,
        liveProfile: { coveredDuplicate: position.coveredThrough !== null && commit.commitSequence <= position.coveredThrough,
          assertCurrent } }, commit);
      if (outcome.status !== 'committed' && outcome.status !== 'deduplicated') {
        if ('reason' in outcome && ['unsupported_live_routing', 'marker_lifetime_violation'].includes(outcome.reason)) {
          throw new Error(outcome.reason);
        }
        throw new Error('live_definition_failed');
      }
    }
  }

  private async candidate(incoming: ProjectionSourceCommit, position: LiveSourcePosition): Promise<ProjectionSourceCommit> {
    const options = this.options;
    const expected = nextSequence(position);
    if (incoming.commitSequence <= expected) return incoming;
    // A one-commit page bounds payload lifetime and never crosses below the durable live floor.
    const request = { sourceId: incoming.streamId, afterSequence: expected === 0 ? null : expected - 1,
      throughSequence: expected, maxCommits: 1, maxBytes: options.budget.maxBytes };
    const page = await options.rangeReader.readCompleteRange(request);
    if (page.status !== 'complete' || !validateCompleteCommitRange(request, page).valid || !page.commits[0]) {
      throw new Error('live_history_unavailable');
    }
    return page.commits[0].commit;
  }

  private async run(incoming: ProjectionSourceCommit, initial: LiveSourcePosition,
    assertCurrent: () => void): Promise<LiveCommitResult> {
    const options = this.options;
    let position = initial;
    let processedCommits = 0;
    let bytes = 0;
    const started = this.now();
    try {
      assertCurrent();
      const loaded = await options.sourceOrder.load(initial.sourceId, options.epoch);
      if (!loaded || !sameLiveFloor(initial, loaded) || loaded.registryDigest !== options.registryDigest) {
        throw new Error('live_position_identity_conflict');
      }
      position = loaded;
      if (incoming.events.length > options.budget.maxEventsPerCommit) throw new Error('live_work_capacity');
      validateIncoming(incoming, position);
      while (processedCommits < options.budget.maxCommits && this.now() - started < options.budget.maxMilliseconds) {
        assertCurrent();
        const commit = await this.candidate(incoming, position);
        validateIncoming(commit, position);
        if (this.now() - started >= options.budget.maxMilliseconds) break;
        const size = new TextEncoder().encode(JSON.stringify(commit)).byteLength;
        if (size > options.budget.maxBytes) throw new Error('live_payload_capacity');
        if (bytes + size > options.budget.maxBytes) break;
        await this.dispatch(commit, position, assertCurrent);
        assertCurrent();
        if (commit.commitSequence === nextSequence(position)) {
          position = await options.sourceOrder.advanceCoverage(position, commit.commitSequence);
        }
        processedCommits += 1;
        bytes += size;
        if (commit.commitSequence === incoming.commitSequence) return { status: 'completed', processedCommits, coveredThrough: position.coveredThrough };
      }
      return { status: 'continuation', processedCommits, coveredThrough: position.coveredThrough };
    } catch (error) {
      return { status: 'paused', processedCommits, coveredThrough: position.coveredThrough, reason: pauseReason(error) };
    }
  }

  async process(commit: ProjectionSourceCommit, position: LiveSourcePosition, assertCurrent: () => void): Promise<LiveCommitResult> {
    if (this.active) return { status: 'paused', processedCommits: 0, coveredThrough: position.coveredThrough, reason: 'live_slot_busy' };
    this.active = true;
    try { return await this.run(commit, position, assertCurrent); } finally { this.active = false; }
  }
}

export function createLiveCommitCoordinator<TState>(options: LiveCommitCoordinatorOptions<TState>): LiveCommitCoordinator {
  return new LiveCoordinator(options);
}
