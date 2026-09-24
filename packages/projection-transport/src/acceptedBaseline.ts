import { isCanonicalProjectionUuid, type ProjectionQueueRegistryManifest,
  type ProjectionCutoverStrategyScope } from '@redemeine/projection-runtime-core';
import type { TapewormMongoRangeReader } from './tapewormMongoRangeReader';

export interface AcceptedBaseline {
  readonly version: 2;
  readonly queueBindingId: string;
  readonly manifestId: string;
  readonly registryGeneration: string;
  readonly sourceId: string;
  readonly lastAcceptedSequence: number;
  readonly startAnchor: number;
  readonly kind: 'existing';
  readonly operator: string;
  readonly acceptedAt: string;
  readonly acknowledgesUnverifiedHistoryAndCutoff: true;
  readonly oldWriterStoppedBy: string;
  readonly oldWriterStoppedAt: string;
  readonly queueTailReadinessReference: string;
  readonly strategyScope: readonly ProjectionCutoverStrategyScope[];
}

export function assertAcceptedBaseline(record: AcceptedBaseline, manifest: ProjectionQueueRegistryManifest): void {
  if (record.version !== 2 || record.queueBindingId !== manifest.queueId || record.manifestId !== manifest.manifestId
    || record.registryGeneration !== manifest.registryGeneration || !isCanonicalProjectionUuid(record.sourceId)
    || !Number.isSafeInteger(record.lastAcceptedSequence) || record.lastAcceptedSequence < -1
    || record.lastAcceptedSequence >= Number.MAX_SAFE_INTEGER || record.startAnchor !== record.lastAcceptedSequence + 1
    || record.acknowledgesUnverifiedHistoryAndCutoff !== true
    || !record.operator || !record.acceptedAt || !record.oldWriterStoppedBy || !record.oldWriterStoppedAt
    || !record.queueTailReadinessReference) {
    throw new Error('Invalid accepted-baseline cutover record.');
  }
  if (record.kind !== 'existing' || 'sourceBirthReference' in record || 'tailReadyThrough' in record) {
    throw new Error('New source birth registration is disabled without authoritative source-side evidence.');
  }
  const manifestAnchor = manifest.sourceStartAnchors[record.sourceId];
  if (manifestAnchor !== undefined && manifestAnchor !== record.startAnchor) {
    throw new Error('Accepted baseline conflicts with registry source anchor.');
  }
  if (!Array.isArray(record.strategyScope) || record.strategyScope.length !== manifest.definitions.length) {
    throw new Error('Cutover strategy scope must cover the immutable registry exactly.');
  }
  for (const [index, scope] of record.strategyScope.entries()) {
    const definition = manifest.definitions[index];
    if (!definition || scope.projectionName !== definition.projectionName || scope.generation !== definition.generation
      || !['in_document', 'own_record', 'none'].includes(scope.strategy)
      || typeof scope.stableSingleTarget !== 'boolean'
      || (definition.joined === true && scope.strategy === 'in_document')
      || (scope.strategy === 'in_document' && !scope.stableSingleTarget)) {
      throw new Error('Invalid or unsupported immutable cutover strategy scope.');
    }
  }
}

export async function probeAcceptedTail(record: AcceptedBaseline, reader: TapewormMongoRangeReader): Promise<number> {
  if (!reader.capability.completeCommitBoundaries || !reader.capability.unslicedCommitEvents) {
    throw new Error('Complete indexed tail reader is required.');
  }
  return reader.probeSource(record.sourceId, record.lastAcceptedSequence);
}
