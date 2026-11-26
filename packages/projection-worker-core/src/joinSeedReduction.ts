import type {
  JoinSeedEventCoverage, JoinSeedKey, JoinSeedProvenance, JoinSeedRegistration, ProjectionEvent,
  ProjectionJoinMembership, ProjectionSourceCommit, ProjectionSourceEvent
} from '@redemeine/projection-runtime-core';
import {
  checkedJoinMembershipKey, isJoinSeedIdentity, joinMembershipKey, ownProjectionState, ProjectionJoinMembershipValidationError
} from '@redemeine/projection-runtime-core';
import type { Draft } from 'immer';
import type { JoinSeedReader, JoinSeedRead } from './joinSeedReaders';
import { sourceEventToProjectionEvent } from './projectionCommitRouting';

export interface JoinSeedInput {
  readonly key: string;
  readonly aggregateId: string;
  readonly reader: JoinSeedReader;
}

export class NeedsJoinSeeds extends Error {
  constructor(readonly inputs: readonly JoinSeedInput[]) {
    super('Join initialization requires seed inputs.');
  }
}

export interface JoinSeedInputs {
  readonly readers: ReadonlyMap<string, JoinSeedReader>;
  readonly loaded: ReadonlyMap<string, JoinSeedRead<unknown>>;
}

type SourceTurn = Pick<ProjectionSourceCommit, 'streamId' | 'commitSequence'>;

function coverageFor(proof: JoinSeedProvenance, event: ProjectionSourceEvent, commit: SourceTurn): JoinSeedEventCoverage {
  if (event.aggregateType !== proof.aggregateType || event.aggregateId !== proof.aggregateId) return 'differentSource';
  const { position } = proof;
  if (position.kind === 'unknown') return 'unknown';
  if (commit.streamId !== position.streamId) throw new Error('Join seed proof does not refer to the triggering aggregate stream.');
  return commit.commitSequence <= position.commitSequence ? 'covered' : 'uncovered';
}

function assertDeployment(proof: JoinSeedProvenance, reader: JoinSeedReader | undefined): void {
  const config = reader?.deployment;
  if (!config || config.from !== proof.from || config.seedName !== proof.seedName
    || config.seedGeneration !== proof.seedGeneration || (config.policy === 'proven') !== (proof.position.kind === 'throughCommit')) {
    throw new Error('Stored join seed provenance does not match the deployment.');
  }
}

interface EdgeChange<T> {
  readonly key: string;
  readonly initial: JoinSeedProvenance | undefined;
  readonly initiallyPresent: boolean;
  present: boolean;
  requested?: { input: JoinSeedInput; initializer: JoinSeedRegistration<T> };
}

export class JoinSeedEvent<T> {
  readonly applied: JoinSeedProvenance[] = [];
  readonly coverage: JoinSeedEventCoverage | undefined;
  private readonly changes = new Map<string, EdgeChange<T>>();

  constructor(private readonly settings: {
    event: ProjectionSourceEvent;
    commit: SourceTurn;
    target: string;
    memberships: Map<string, ProjectionJoinMembership>;
    initializers: readonly JoinSeedRegistration<T>[];
    seeds: JoinSeedInputs;
  }, joined: boolean) {
    const { event, target, memberships, seeds, commit } = settings;
    const row = joined ? memberships.get(joinMembershipKey(event.aggregateType, event.aggregateId)) : undefined;
    const proof = row?.seeds?.find((edge) => edge.targetDocumentId === target)?.provenance;
    if (proof) {
      assertDeployment(proof, seeds.readers.get(proof.aggregateType));
      this.coverage = coverageFor(proof, event, commit);
    }
  }

  stage(type: string, id: string, subscribe: boolean, binding?: JoinSeedKey): void {
    const { memberships, target, initializers, seeds } = this.settings;
    const key = checkedJoinMembershipKey(type, id);
    const row = memberships.get(key);
    const initializer = binding && initializers.find((item) => item.binding === binding && binding.sourceAggregateType === type);
    const reader = initializer && seeds.readers.get(type);
    if (binding !== undefined && (!initializer || !reader || !isJoinSeedIdentity(id))) {
      throw new ProjectionJoinMembershipValidationError('subscribeTo initialization requires the registered binding and a valid aggregate ID.');
    }
    if (!row) return;
    const present = row.targetDocumentIds.includes(target);
    const initial = row.seeds?.find((entry) => entry.targetDocumentId === target)?.provenance;
    const change = this.changes.get(key) ?? { key, initial, initiallyPresent: present, present };
    if (!subscribe) delete change.requested;
    else if (!change.initiallyPresent && !change.present && initializer && reader) {
      change.requested = { input: { key, aggregateId: id, reader }, initializer };
    }
    change.present = subscribe;
    this.changes.set(key, change);
  }

  finish(draft: Draft<T>): void {
    const { seeds, event, commit, target } = this.settings;
    const missing: JoinSeedInput[] = [];
    for (const { requested } of this.changes.values()) {
      if (requested && !seeds.loaded.has(requested.input.key)) missing.push(requested.input);
    }
    if (missing.length) throw new NeedsJoinSeeds(missing);
    for (const change of this.changes.values()) {
      const seed = change.requested && seeds.loaded.get(change.requested.input.key);
      if (seed) {
        const coverage = coverageFor(seed.provenance, event, commit);
        runInitializer(change.requested!.initializer, draft, seed, target, sourceEventToProjectionEvent(event), coverage);
        this.applied.push(seed.provenance);
      }
      this.writeEdge(change, change.present ? seed?.provenance ?? change.initial : undefined);
    }
  }

  private writeEdge(change: EdgeChange<T>, proof: JoinSeedProvenance | undefined): void {
    if (proof === change.initial) return;
    const { target, memberships } = this.settings;
    const { seeds, ...row } = memberships.get(change.key)!;
    const entries = (seeds ?? []).filter((edge) => edge.targetDocumentId !== target);
    if (proof) entries.push({ targetDocumentId: target, provenance: proof });
    entries.sort((a, b) => a.targetDocumentId < b.targetDocumentId ? -1 : 1);
    memberships.set(change.key, { ...row, ...(entries.length ? { seeds: entries } : {}) });
  }
}

function runInitializer<T>(
  registration: JoinSeedRegistration<T>, draft: Draft<T>, seed: JoinSeedRead<unknown>, targetDocumentId: string,
  event: ProjectionEvent, coverage: JoinSeedEventCoverage
): void {
  const detachedEvent = structuredClone(event);
  // The callback sees a detached source event, not a BSON value to be persisted.
  if (!ownProjectionState(detachedEvent)) throw new Error('Join initializer event could not be made immutable.');
  const result: unknown = registration.initialize(draft, seed.state,
    Object.freeze({ event: detachedEvent, targetDocumentId, provenance: seed.provenance, coverage }));
  if (result === undefined) return;
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(() => undefined);
  throw new Error('Projection .onJoinInitialize() must be synchronous and may only mutate the draft.');
}
