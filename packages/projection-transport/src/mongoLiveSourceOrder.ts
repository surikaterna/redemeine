import {
  isCanonicalProjectionUuid, sameLiveFloor,
  type FirstLiveEvidence, type LiveSourceOrderPort, type LiveSourcePosition
} from '@redemeine/projection-runtime-core';
import type { Collection } from 'mongodb';

export interface LiveSourcePositionDocument extends LiveSourcePosition { readonly _id: string }

function key(epoch: string, sourceId: string): string {
  return JSON.stringify([epoch, sourceId]);
}

function assertPosition(position: LiveSourcePosition): void {
  if (!position.epoch || position.epoch.length > 512 || !position.registryDigest || position.registryDigest.length > 512
    || !isCanonicalProjectionUuid(position.sourceId) || !isCanonicalProjectionUuid(position.firstCommitId)
    || !Number.isSafeInteger(position.firstSequence) || position.firstSequence < 0
    || (position.coveredThrough !== null && (!Number.isSafeInteger(position.coveredThrough)
      || position.coveredThrough < position.firstSequence))) throw new Error('invalid_live_position');
}

/** Dedicated collection; the built-in unique _id index is the point-CAS key. No inventory cache. */
export class MongoLiveSourceOrder implements LiveSourceOrderPort {
  constructor(private readonly collection: Pick<Collection<LiveSourcePositionDocument>, 'findOne' | 'updateOne'>) {}

  async load(sourceId: string, epoch: string): Promise<LiveSourcePosition | null> {
    const row = await this.collection.findOne({ _id: key(epoch, sourceId) }, { readConcern: { level: 'majority' } });
    if (!row) return null;
    assertPosition(row);
    if (row.sourceId !== sourceId || row.epoch !== epoch) throw new Error('live_position_identity_conflict');
    return { epoch: row.epoch, registryDigest: row.registryDigest, sourceId: row.sourceId,
      firstSequence: row.firstSequence, firstCommitId: row.firstCommitId, coveredThrough: row.coveredThrough };
  }

  async admitFirst(evidence: FirstLiveEvidence): Promise<LiveSourcePosition> {
    evidence.assertCurrent();
    const position = evidence.position;
    assertPosition(position);
    if (position.coveredThrough !== null || evidence.start.epoch !== position.epoch
      || evidence.start.registryDigest !== position.registryDigest
      || evidence.delivery.messageId !== position.firstCommitId) throw new Error('invalid_first_live_evidence');
    try {
      await this.collection.updateOne({ _id: key(position.epoch, position.sourceId) },
        { $setOnInsert: position }, { upsert: true, writeConcern: { w: 'majority' } });
    } catch {
      // Unknown writes are resolved only by the exact immutable majority identity below.
    }
    const stored = await this.load(position.sourceId, position.epoch);
    evidence.assertCurrent();
    if (!stored || !sameLiveFloor(stored, position)) throw new Error('live_floor_conflict_or_unknown');
    return stored;
  }

  async advanceCoverage(expected: LiveSourcePosition, sequence: number): Promise<LiveSourcePosition> {
    assertPosition(expected);
    if (!Number.isSafeInteger(sequence) || sequence !== (expected.coveredThrough === null
      ? expected.firstSequence : expected.coveredThrough + 1)) throw new Error('noncontiguous_live_coverage');
    try {
      await this.collection.updateOne({ _id: key(expected.epoch, expected.sourceId), ...expected },
        { $set: { coveredThrough: sequence } }, { writeConcern: { w: 'majority' } });
    } catch {
      // An ambiguous CAS cannot authorize a different floor or a merely later coverage value.
    }
    const stored = await this.load(expected.sourceId, expected.epoch);
    if (!stored || !sameLiveFloor(stored, expected) || stored.coveredThrough !== sequence) {
      throw new Error('live_coverage_conflict_or_unknown');
    }
    return stored;
  }
}
