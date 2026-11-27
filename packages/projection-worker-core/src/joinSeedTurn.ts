import type { JoinSeedInput, JoinSeedInputs } from './joinSeedReduction';
import { readJoinSeed, SEED_TIMEOUT_MS, type JoinSeedRead, type JoinSeedReader } from './joinSeedReaders';

export const MAX_JOIN_SEED_READS = 64;
const MAX_TURN_SEED_BYTES = 8 * 1024 * 1024;

type SeedFailure = { status: 'transient' | 'terminal'; reason: string };

/** Only detached read inputs survive a replan; target drafts and membership never do. */
export class JoinSeedTurn implements JoinSeedInputs {
  readonly readers: ReadonlyMap<string, JoinSeedReader>;
  readonly loaded = new Map<string, JoinSeedRead<unknown>>();
  private readonly failures = new Map<string, SeedFailure>();
  private providerReads = 0;
  private bytes = 0;
  private readonly deadline: number;

  constructor(readers: readonly JoinSeedReader[], startedAt: number) {
    this.deadline = startedAt + SEED_TIMEOUT_MS;
    this.readers = new Map(readers.map((reader) => [reader.deployment.aggregateType, reader]));
  }

  get hasFailures(): boolean { return this.failures.size !== 0; }

  async load(inputs: readonly JoinSeedInput[]): Promise<(SeedFailure & { phase: 'fresh' | 'confirmed' | 'planned_limit' }) | undefined> {
    const pending = new Map(inputs.map((input) => [input.key, input]));
    for (const key of pending.keys()) {
      const failure = this.failures.get(key);
      if (failure) return { ...failure, phase: 'confirmed' };
    }
    if (this.providerReads + pending.size > MAX_JOIN_SEED_READS) {
      return { status: 'terminal', reason: 'Join seed read count exceeds capacity.', phase: 'planned_limit' };
    }
    for (const input of pending.values()) {
      const failure = await this.loadOne(input);
      if (!failure) continue;
      this.failures.set(input.key, failure);
      return { ...failure, phase: 'fresh' };
    }
  }

  private async loadOne({ key, reader, aggregateId, expectedStreamId }: JoinSeedInput): Promise<SeedFailure | undefined> {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) return { status: 'transient', reason: 'Join seed turn deadline exceeded.' };
    this.providerReads += 1;
    const outcome = await readJoinSeed(reader, aggregateId, remaining);
    if (outcome.status !== 'loaded') return { status: outcome.status, reason: outcome.reason };
    if (performance.now() >= this.deadline) return { status: 'transient', reason: 'Join seed turn deadline exceeded.' };
    const position = outcome.seed.provenance.position;
    if (expectedStreamId && position.kind === 'throughCommit' && expectedStreamId !== position.streamId) {
      return { status: 'terminal', reason: 'Join seed proof does not refer to the triggering aggregate stream.' };
    }
    if (this.bytes + outcome.bytes > MAX_TURN_SEED_BYTES) return { status: 'terminal', reason: 'Join seed turn bytes exceed capacity.' };
    this.bytes += outcome.bytes;
    this.loaded.set(key, outcome.seed);
  }
}
