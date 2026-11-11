import { sameLiveFloor, type FirstLiveEvidence, type LiveSourceOrderPort,
  type LiveSourcePosition } from '@redemeine/projection-runtime-core';

export class ModelSourceOrder implements LiveSourceOrderPort {
  private readonly positions = new Map<string, LiveSourcePosition>();

  constructor(private readonly trace: string[]) {}

  async load(sourceId: string, epoch: string): Promise<LiveSourcePosition | null> {
    const position = this.positions.get(sourceId);
    if (position && position.epoch !== epoch) throw new Error('model:epoch_mismatch');
    return position ?? null;
  }

  async admitFirst(evidence: FirstLiveEvidence): Promise<LiveSourcePosition> {
    evidence.assertCurrent();
    const position = evidence.position;
    const existing = this.positions.get(position.sourceId);
    if (existing && !sameLiveFloor(existing, position)) throw new Error('model:floor_conflict');
    if (existing) return existing;
    if (this.positions.size >= 32 || position.coveredThrough !== null) throw new Error('model:floor_refused');
    const stored = Object.freeze({ ...position });
    this.positions.set(position.sourceId, stored);
    this.trace.push(`model:floor:${position.firstSequence}`);
    return stored;
  }

  async advanceCoverage(expected: LiveSourcePosition, sequence: number): Promise<LiveSourcePosition> {
    const current = this.positions.get(expected.sourceId);
    if (!current || !sameLiveFloor(current, expected) || current.coveredThrough !== expected.coveredThrough
      || sequence !== (current.coveredThrough === null ? current.firstSequence : current.coveredThrough + 1)) {
      throw new Error('model:coverage_conflict');
    }
    const next = Object.freeze({ ...current, coveredThrough: sequence });
    this.positions.set(current.sourceId, next);
    this.trace.push(`model:coverage:${sequence}`);
    return next;
  }
}
