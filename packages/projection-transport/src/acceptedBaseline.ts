import { isCanonicalProjectionUuid, validateCompleteCommitRange, type ProjectionCompleteCommitRangeReader,
  type ProjectionQueueRegistryManifest, type ProjectionCutoverStrategyScope } from '@redemeine/projection-runtime-core';

export interface AcceptedBaseline {
  readonly version: 1;
  readonly queueBindingId: string;
  readonly manifestId: string;
  readonly registryGeneration: string;
  readonly sourceId: string;
  readonly lastAcceptedSequence: number;
  readonly startAnchor: number;
  readonly kind: 'existing' | 'birth';
  readonly sourceBirthReference?: string;
  readonly operator: string;
  readonly acceptedAt: string;
  readonly acknowledgesUnverifiedHistoryAndCutoff: true;
  readonly oldWriterStoppedBy: string;
  readonly oldWriterStoppedAt: string;
  readonly queueTailReadinessReference: string;
  readonly tailReadyThrough: number;
  readonly strategyScope: readonly ProjectionCutoverStrategyScope[];
}

export function assertAcceptedBaseline(record: AcceptedBaseline, manifest: ProjectionQueueRegistryManifest): void {
  if (record.version !== 1 || record.queueBindingId !== manifest.queueId || record.manifestId !== manifest.manifestId
    || record.registryGeneration !== manifest.registryGeneration || !isCanonicalProjectionUuid(record.sourceId)
    || !Number.isSafeInteger(record.lastAcceptedSequence) || record.lastAcceptedSequence < -1
    || record.lastAcceptedSequence >= Number.MAX_SAFE_INTEGER || record.startAnchor !== record.lastAcceptedSequence + 1
    || record.acknowledgesUnverifiedHistoryAndCutoff !== true
    || !record.operator || !record.acceptedAt || !record.oldWriterStoppedBy || !record.oldWriterStoppedAt
    || !record.queueTailReadinessReference || !Number.isSafeInteger(record.tailReadyThrough)
    || record.tailReadyThrough < record.lastAcceptedSequence) {
    throw new Error('Invalid accepted-baseline cutover record.');
  }
  if (record.kind === 'birth' ? record.lastAcceptedSequence !== -1 || !record.sourceBirthReference
    : record.kind !== 'existing' || !!record.sourceBirthReference) {
    throw new Error('New source requires explicit birth evidence and a zero anchor.');
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
      || (scope.strategy === 'in_document' && !scope.stableSingleTarget)) {
      throw new Error('Invalid or unsupported immutable cutover strategy scope.');
    }
  }
}

export async function probeAcceptedTail(record: AcceptedBaseline, reader: ProjectionCompleteCommitRangeReader,
  maxBytes: number): Promise<void> {
  if (!reader.capability.completeCommitBoundaries || !reader.capability.unslicedCommitEvents) {
    throw new Error('Complete indexed tail reader is required.');
  }
  if (record.tailReadyThrough < record.startAnchor) return;
  const request = { sourceId: record.sourceId, afterSequence: record.lastAcceptedSequence === -1 ? null : record.lastAcceptedSequence,
    throughSequence: record.startAnchor, maxCommits: 1, maxBytes };
  const result = await reader.readCompleteRange(request);
  if (!validateCompleteCommitRange(request, result).valid || result.status !== 'complete') {
    throw new Error('Indexed complete source tail is not ready at B+1.');
  }
}
