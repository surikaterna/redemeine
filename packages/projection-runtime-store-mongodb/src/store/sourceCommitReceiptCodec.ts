import {
  isJoinSeedProvenance, type JoinSeedProvenance, type ProjectionChangesReceipt
} from '@redemeine/projection-runtime-core';
import type { MongoProjectionChangesRecord } from '../types';
import { ReceiptBudget } from './sourceCommitReceiptBson';

function descriptorKey(proof: JoinSeedProvenance): string {
  const { aggregateType, aggregateId, from, seedName, seedGeneration, documentId, position } = proof;
  return JSON.stringify([aggregateType, aggregateId, from, seedName, seedGeneration, documentId,
    position.kind, ...(position.kind === 'throughCommit'
      ? [position.streamId, Object.is(position.commitSequence, -0) ? '-0' : position.commitSequence] : [])]);
}

export function encodeMongoReceipt(
  receipt: ProjectionChangesReceipt, outcome: MongoProjectionChangesRecord['outcome']
): MongoProjectionChangesRecord {
  const base = { _id: receipt.resumeToken, outcome };
  if (receipt.kind === 'projection_changes') return encodeTargets(receipt, base);
  const row = { ...receipt, ...base };
  new ReceiptBudget(row);
  return row;
}

function encodeTargets(receipt: Extract<ProjectionChangesReceipt, { kind: 'projection_changes' }>,
  base: Pick<MongoProjectionChangesRecord, '_id' | 'outcome'>): MongoProjectionChangesRecord {
  const { targets: publicTargets, ...envelope } = receipt;
  const budget = new ReceiptBudget({ ...envelope, ...base });
  const descriptors: JoinSeedProvenance[] = [];
  const indices = new Map<string, number>();
  const intern = (proof: JoinSeedProvenance): number => {
    const key = descriptorKey(proof);
    const index = indices.get(key);
    if (index !== undefined) return index;
    const next = descriptors.length;
    if (next === 0) {
      budget.open('seedEncoding');
      budget.add('kind', 'interned-v1');
      budget.open('descriptors');
    }
    budget.add(next, proof);
    descriptors.push(proof);
    indices.set(key, next);
    return next;
  };
  budget.open('targets');
  const targets = publicTargets.map(({ transitions, ...target }, targetIndex) => {
    budget.add(targetIndex, target);
    budget.open('transitions');
    return { ...target, transitions: transitions.map(({ joinSeeds, patch, ...transition }, transitionIndex) => {
      budget.add(transitionIndex, transition);
      budget.open('patch');
      patch.forEach((op, index) => budget.add(index, op));
      const refs = joinSeeds?.map(intern);
      if (refs) budget.add('joinSeedRefs', refs);
      return { ...transition, patch, ...(refs ? { joinSeedRefs: refs } : {}) };
    }) };
  });
  return { ...envelope, ...base, targets, ...(descriptors.length ? { seedEncoding: { kind: 'interned-v1', descriptors } } : {}) };
}

const invalid = (): never => { throw new Error('Malformed MongoDB projection_changes seed encoding.'); };

function decodeDescriptors(encoding: MongoProjectionChangesRecord['seedEncoding']): readonly JoinSeedProvenance[] | undefined {
  if (encoding === undefined) return undefined;
  if (!encoding || encoding.kind !== 'interned-v1' || Object.keys(encoding).length !== 2
    || !Array.isArray(encoding.descriptors) || !encoding.descriptors.length
    || !encoding.descriptors.every(isJoinSeedProvenance)) return invalid();
  if (new Set(encoding.descriptors.map(descriptorKey)).size !== encoding.descriptors.length) return invalid();
  return encoding.descriptors;
}

/** Read either physical encoding; never expose descriptor indexes as public transitions. */
export function decodeMongoProjectionChangesReceipt(row: MongoProjectionChangesRecord): ProjectionChangesReceipt {
  const { _id: _id, outcome: _outcome, seedEncoding, ...receipt } = row;
  const descriptors = decodeDescriptors(seedEncoding);
  if (receipt.kind === 'projection_changes_empty') return descriptors || 'targets' in receipt ? invalid() : receipt;
  const used = new Set<number>();
  const targets = receipt.targets.map(({ transitions, ...target }) => ({
    ...target, transitions: transitions.map(({ joinSeedRefs, joinSeeds, ...transition }) => {
      if (joinSeeds !== undefined && (descriptors || !Array.isArray(joinSeeds) || !joinSeeds.length
        || joinSeeds.length > 64 || !joinSeeds.every(isJoinSeedProvenance))) return invalid();
      if (joinSeedRefs === undefined) return { ...transition, ...(joinSeeds ? { joinSeeds } : {}) };
      if (!descriptors || !Array.isArray(joinSeedRefs) || !joinSeedRefs.length || joinSeedRefs.length > 64) return invalid();
      const expanded = joinSeedRefs.map((index) => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= descriptors.length) return invalid();
        used.add(index);
        return descriptors[index]!;
      });
      return { ...transition, joinSeeds: expanded };
    })
  }));
  if (descriptors && used.size !== descriptors.length) return invalid();
  return { ...receipt, targets };
}
