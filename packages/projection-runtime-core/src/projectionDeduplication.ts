export interface ProjectionDedupeWarningPolicy {
  /** Advisory threshold only; crossing it must not change processing behavior. */
  warnAtSourceCount?: number;
  /** Advisory threshold only; crossing it must not change processing behavior. */
  warnAtMetadataBytes?: number;
}

export interface ProjectionInDocumentDeduplication {
  strategy: 'in_document';
  warnings?: ProjectionDedupeWarningPolicy;
}

export interface ProjectionOwnRecordDeduplication {
  strategy: 'own_record';
  warnings?: ProjectionDedupeWarningPolicy;
}

export interface ProjectionNoDeduplication {
  strategy: 'none';
  duplicateEffects: 'acknowledged';
  reason: string;
}

export type ProjectionDeduplicationStrategy =
  | ProjectionInDocumentDeduplication
  | ProjectionOwnRecordDeduplication
  | ProjectionNoDeduplication;
