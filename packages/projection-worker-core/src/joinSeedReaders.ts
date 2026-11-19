import { isDeepStrictEqual } from 'node:util';
import {
  freezeJoinSeedProvenance, freezePortableProjectionChangeJson, isJoinSeedBinding, isJoinSeedDeployment, isJoinSeedProvenance,
  isPortableProjectionChangeJson, validateJoinInitializers,
  type JoinSeed, type JoinSeedDeployment, type JoinSeedKey, type JoinSeedProvenance,
  type ReadonlySeed
} from '@redemeine/projection-runtime-core';
import type { ProjectionCommitDefinitionInput } from './commitCoordinatorContracts';

export interface JoinSeedRead<TState> {
  readonly state: ReadonlySeed<TState>;
  readonly provenance: JoinSeedProvenance;
}

export interface JoinSeedReader {
  readonly binding: JoinSeedKey;
  readonly deployment: JoinSeedDeployment;
  readonly readOne: (aggregateId: string, signal: AbortSignal) => Promise<JoinSeedRead<unknown> | null>;
}

const declaredReaders = new WeakSet<JoinSeedReader>();

/** Bind a deployment reader without putting I/O into a projection definition. */
export function bindJoinSeedReader<TSource extends { aggregateType: string }, TSeed>(
  binding: JoinSeed<TSource, TSeed>, options: Pick<JoinSeedDeployment, 'seedGeneration' | 'policy'> & {
    readOne: (aggregateId: string, signal: AbortSignal) => Promise<JoinSeedRead<NoInfer<TSeed>> | null>;
  }
): JoinSeedReader {
  const { sourceAggregateType: aggregateType, from, seedName } = binding;
  const { seedGeneration, policy, readOne } = options;
  const deployment = { aggregateType, from, seedName, seedGeneration, policy };
  if (!isJoinSeedBinding(binding) || !isJoinSeedDeployment(deployment)
    || typeof readOne !== 'function') throw new Error('Invalid join seed reader configuration.');
  const reader = Object.freeze({ binding, deployment: Object.freeze(deployment), readOne });
  declaredReaders.add(reader);
  return reader;
}

export function joinSeedDeployments(readers: readonly JoinSeedReader[]): readonly JoinSeedDeployment[] {
  return readers.map((reader) => reader.deployment).sort((a, b) => a.aggregateType < b.aggregateType ? -1
    : a.aggregateType === b.aggregateType ? 0 : 1);
}

export function assertJoinSeedConfiguration<T>(
  definition: ProjectionCommitDefinitionInput<T>, readers: readonly JoinSeedReader[],
  declared: readonly JoinSeedDeployment[] | undefined, capable: boolean
): void {
  const initializers = definition.joinInitializers ?? [];
  if (!initializers.length && !readers.length && declared === undefined) return;
  validateJoinInitializers(initializers, definition.fromStream.aggregate.aggregateType, definition.joinStreams ?? [], definition.deduplication);
  if (!capable || definition.joinMembership !== 'set-v1' || !initializers.length || readers.length !== initializers.length) {
    throw new Error('Join initialization requires an atomic seed store and exactly one reader per binding.');
  }
  if (readers.some((reader) => !declaredReaders.has(reader))
    || initializers.some((init) => !Object.isFrozen(init.binding) || typeof init.initialize !== 'function'
      || readers.filter((reader) => reader.binding === init.binding).length !== 1)
    || !isDeepStrictEqual(joinSeedDeployments(readers), declared)) {
    throw new Error('Join seed bindings and readers must match the immutable manifest for this generation.');
  }
}

const SEED_TIMEOUT_MS = 5_000;
const MAX_SEED_BYTES = 1024 * 1024;

type SeedReadOutcome =
  | { status: 'loaded'; seed: JoinSeedRead<unknown>; bytes: number }
  | { status: 'transient' | 'terminal'; reason: string };

function checkSeed(result: JoinSeedRead<unknown> | null, config: JoinSeedDeployment, aggregateId: string): SeedReadOutcome {
  if (result == null) return { status: 'transient', reason: 'Join seed is not available.' };
  const p = result.provenance;
  const proof = p?.position === undefined ? { ...p, position: { kind: 'unknown' } } : p;
  if (!isJoinSeedProvenance(proof) || !p || p.aggregateType !== config.aggregateType || p.aggregateId !== aggregateId
    || p.from !== config.from || p.seedName !== config.seedName || p.seedGeneration !== config.seedGeneration
    || !isPortableProjectionChangeJson(result.state)) {
    return { status: 'terminal', reason: 'Invalid join seed identity, coverage or state.' };
  }
  if (config.policy === 'proven' && proof.position.kind === 'unknown') {
    return { status: 'transient', reason: 'Join seed is missing required source coverage.' };
  }
  if (config.policy === 'bestEffort' && p.position?.kind !== 'unknown') {
    return { status: 'terminal', reason: 'Best-effort join seed reader must report explicit unknown coverage.' };
  }
  const bytes = Buffer.byteLength(JSON.stringify(result.state));
  if (bytes > MAX_SEED_BYTES) return { status: 'terminal', reason: 'Join seed state exceeds capacity.' };
  const state = structuredClone(result.state);
  if (!freezePortableProjectionChangeJson(state)) return { status: 'terminal', reason: 'Invalid detached join seed state.' };
  return { status: 'loaded', bytes, seed: Object.freeze({ state, provenance: freezeJoinSeedProvenance(p) }) };
}

export async function readJoinSeed(reader: JoinSeedReader, aggregateId: string): Promise<SeedReadOutcome> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: JoinSeedRead<unknown> | null;
  try {
    result = await Promise.race([
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('Join seed read timed out.')); }, SEED_TIMEOUT_MS);
      }),
      reader.readOne(aggregateId, controller.signal)
    ]);
  } catch {
    return { status: 'transient', reason: 'Join seed reader failed or timed out.' };
  } finally {
    clearTimeout(timeout);
  }
  try {
    return checkSeed(result, reader.deployment, aggregateId);
  } catch {
    return { status: 'terminal', reason: 'Invalid join seed reader result.' };
  }
}
