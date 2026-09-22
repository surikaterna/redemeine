export {
  decodeTapewormProjectionCommit,
  type DecodeTapewormCommitResult,
  type TapewormProjectionCommit,
  type TapewormProjectionEvent
} from './tapewormDecoder';
export {
  createTapewormCompleteCommitRangeReader,
  type TapewormIndexedCommit,
  type TapewormIndexedCommitRangeCapability
} from './tapewormRangeReader';
export {
  createTapewormMongoCompleteCommitRangeReader,
  type TapewormMongoRangeReader,
  type TapewormMongoRangeReaderOptions
} from './tapewormMongoRangeReader';
export {
  MongoProjectionTransportStore,
  type MongoProjectionTransportStoreOptions,
  type ProjectionTransportBindingDocument,
  type ProjectionTransportCoverageDocument,
  type ProjectionTransportDocument
} from './mongoTransportStore';
export {
  ProjectionRabbitWorker,
  type ProjectionRabbitChannel,
  type ProjectionRabbitRetryReceipt,
  type ProjectionRabbitWorkerOptions,
  type RabbitDelivery,
  type RabbitSettlementEvent,
  type RabbitSettlementKind
} from './rabbitWorker';
export { ProjectionMigrationStreamingDigest, projectionMigrationDigest, projectionMigrationManifestPayload } from './migration/digest';
export { ProjectionMigrationEngine } from './migration/engine';
export {
  MongoProjectionMigrationActivationPort,
  MongoProjectionMigrationPreflightPort,
  MongoProjectionMigrationSnapshotPort,
  MongoProjectionMigrationStatePort,
  MongoProjectionGenerationResolver,
  type ProjectionActiveGenerationRecord,
  type ProjectionGenerationCollections,
  type ProjectionGenerationRecord,
  type ProjectionMigrationJournalDocument,
  type ProjectionMigrationStateDocument
} from './migration/mongoPorts';
export {
  assertExactJournal,
  replayProjectionMigrationRanges,
  scanProjectionMigrationRange,
  verifyProjectionMigrationSources
} from './migration/replay';
export type {
  ProjectionMigrationActivationPort,
  ProjectionMigrationManifest,
  ProjectionMigrationPhase,
  ProjectionMigrationRangeJournal,
  ProjectionMigrationReplayPort,
  ProjectionMigrationReceipt,
  ProjectionMigrationSnapshot,
  ProjectionMigrationSnapshotPort,
  ProjectionMigrationSourceRange,
  ProjectionMigrationState,
  ProjectionMigrationStatePort,
  ProjectionMigrationStrategy,
  ProjectionMigrationTrustedPreflightPort
} from './migration/types';
export {
  parseProjectionMigrationManifest,
  PROJECTION_MIGRATION_MAX_MANIFEST_BYTES,
  PROJECTION_MIGRATION_MAX_RANGES,
  projectionMigrationRangeKey,
  projectionMigrationSourceDescriptorDigest,
  validateProjectionMigrationManifest
} from './migration/validate';
