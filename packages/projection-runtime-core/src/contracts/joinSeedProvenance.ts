import type { JoinSeedKey, JoinSeedPosition, JoinSeedProvenance } from '../joinSeed';
import { isCanonicalProjectionUuid } from './sourceCommit';
import { isPortableProjectionChangeKey } from './projectionChangeJson';

export interface JoinSeedDeployment {
  readonly aggregateType: string;
  readonly from: JoinSeedKey['from'];
  readonly seedName: string;
  readonly seedGeneration: string;
  readonly policy: 'proven' | 'bestEffort';
}

export interface JoinSeedEdge {
  readonly targetDocumentId: string;
  readonly provenance: JoinSeedProvenance;
}

export function isJoinSeedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && value.trim().length > 0 && isPortableProjectionChangeKey(value);
}

export function isJoinSeedPosition(value: unknown): value is JoinSeedPosition {
  if (!record(value)) return false;
  if (value.kind === 'unknown') return Object.keys(value).length === 1;
  return value.kind === 'throughCommit' && Object.keys(value).length === 3
    && isCanonicalProjectionUuid(value.streamId) && typeof value.commitSequence === 'number'
    && Number.isSafeInteger(value.commitSequence) && value.commitSequence >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function isJoinSeedDeployment(value: unknown): value is JoinSeedDeployment {
  return record(value) && Object.keys(value).length === 5 && validIdentity(value)
    && (value.policy === 'proven' || value.policy === 'bestEffort');
}

export function isJoinSeedProvenance(value: unknown): value is JoinSeedProvenance {
  return record(value) && Object.keys(value).length === 7 && validIdentity(value)
    && [value.aggregateId, value.documentId].every(isJoinSeedIdentity)
    && value.documentId === value.aggregateId && isJoinSeedPosition(value.position);
}

function validIdentity(value: Record<string, unknown>): boolean {
  return [value.aggregateType, value.seedName, value.seedGeneration].every(isJoinSeedIdentity)
    && (value.from === 'projection' || (value.from === 'snapshot' && value.seedName === value.aggregateType));
}

export function freezeJoinSeedProvenance(value: JoinSeedProvenance): JoinSeedProvenance {
  return Object.freeze({ ...value, position: Object.freeze({ ...value.position }) });
}

export function freezeJoinSeedEdges(edges: readonly JoinSeedEdge[]): readonly JoinSeedEdge[] {
  return Object.freeze(edges.map(({ targetDocumentId, provenance }) =>
    Object.freeze({ targetDocumentId, provenance: freezeJoinSeedProvenance(provenance) })));
}
