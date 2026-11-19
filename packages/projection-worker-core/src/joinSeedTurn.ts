import type { JoinSeedInput, JoinSeedInputs } from './joinSeedReduction';
import { readJoinSeed, type JoinSeedRead, type JoinSeedReader } from './joinSeedReaders';

export const MAX_JOIN_SEED_READS = 64;
const MAX_TURN_SEED_BYTES = 8 * 1024 * 1024;

/** Only detached read inputs survive a replan; target drafts and membership never do. */
export class JoinSeedTurn implements JoinSeedInputs {
  readonly readers: ReadonlyMap<string, JoinSeedReader>;
  readonly loaded = new Map<string, JoinSeedRead<unknown>>();
  private bytes = 0;

  constructor(readers: readonly JoinSeedReader[]) {
    this.readers = new Map(readers.map((reader) => [reader.deployment.aggregateType, reader]));
  }

  async load(inputs: readonly JoinSeedInput[]): Promise<{ status: 'transient' | 'terminal'; reason: string } | undefined> {
    const pending = new Map(inputs.map((input) => [input.key, input]));
    if (this.loaded.size + pending.size > MAX_JOIN_SEED_READS) return { status: 'terminal', reason: 'Join seed read count exceeds capacity.' };
    for (const [key, { reader, aggregateId }] of pending) {
      const outcome = await readJoinSeed(reader, aggregateId);
      if (outcome.status !== 'loaded') return outcome;
      this.bytes += outcome.bytes;
      if (this.bytes > MAX_TURN_SEED_BYTES) return { status: 'terminal', reason: 'Join seed turn bytes exceed capacity.' };
      this.loaded.set(key, outcome.seed);
    }
  }
}
