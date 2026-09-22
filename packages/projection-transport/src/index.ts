export { ProjectionMigrationStreamingDigest, projectionMigrationDigest, projectionMigrationManifestPayload } from './migration/digest';
export { ProjectionMigrationEngine } from './migration/engine';
export { MongoProjectionMigrationActivationPort, type ProjectionMigrationActivationHooks } from './migration/mongoActivation';
export {
  MongoProjectionGenerationResolver,
  MongoProjectionMigrationPreflightPort,
  MongoProjectionMigrationSnapshotPort,
  MongoProjectionMigrationStatePort,
  type ProjectionActiveGenerationRecord,
  type ProjectionGenerationCollections,
  type ProjectionGenerationRecord,
  type ProjectionMigrationJournalDocument,
  type ProjectionMigrationStateDocument,
  projectionGenerationCollectionsAreIsolated
} from './migration/mongoPorts';
export {
  assertExactJournal,
  replayProjectionMigrationRanges,
  scanProjectionMigrationRange,
  verifyProjectionMigrationSources
} from './migration/replay';
export {
  inspectProjectionMigrationRuntimeArtifact,
  loadProjectionMigrationRuntimeArtifact,
  type ProjectionMigrationRuntimeArtifact
} from './migration/runtimeArtifact';
export {
  assertRuntimeMatchesManifest,
  normalizeProjectionMigrationDefinitions,
  type ProjectionMigrationDeploymentDefinition,
  type ProjectionMigrationRuntimeModule,
  parseProjectionMigrationRuntimeModule,
  projectionDefinitionRegistryDigest,
  projectionMigrationDefinitionHash,
  projectionMigrationRuntimeConfigurationDigest,
  projectionQueueRegistryDigest
} from './migration/runtimeIdentity';
export type {
  ProjectionMigrationActivationPort,
  ProjectionMigrationManifest,
  ProjectionMigrationPhase,
  ProjectionMigrationRangeJournal,
  ProjectionMigrationReceipt,
  ProjectionMigrationReplayPort,
  ProjectionMigrationSnapshot,
  ProjectionMigrationSnapshotPort,
  ProjectionMigrationSourceRange,
  ProjectionMigrationState,
  ProjectionMigrationStatePort,
  ProjectionMigrationStrategy,
  ProjectionMigrationTrustedPreflightPort
} from './migration/types';
export {
  PROJECTION_MIGRATION_MAX_MANIFEST_BYTES,
  PROJECTION_MIGRATION_MAX_RANGES,
  parseProjectionMigrationManifest,
  projectionMigrationRangeKey,
  projectionMigrationSourceDescriptorDigest,
  validateProjectionMigrationManifest
} from './migration/validate';
export {
  MongoProjectionTransportStore,
  type MongoProjectionTransportStoreOptions,
  type ProjectionTransportBindingDocument,
  type ProjectionTransportCoverageDocument,
  type ProjectionTransportDocument
} from './mongoTransportStore';
export {
  type ProjectionRabbitChannel,
  type ProjectionRabbitRetryReceipt,
  ProjectionRabbitWorker,
  type ProjectionRabbitWorkerOptions,
  type RabbitDelivery,
  type RabbitSettlementEvent,
  type RabbitSettlementKind
} from './rabbitWorker';
export {
  type DecodeTapewormCommitResult,
  decodeTapewormProjectionCommit,
  type TapewormProjectionCommit,
  type TapewormProjectionEvent
} from './tapewormDecoder';
export {
  createTapewormMongoCompleteCommitRangeReader,
  type TapewormMongoRangeQueryObservation,
  type TapewormMongoRangeReader,
  type TapewormMongoRangeReaderOptions
} from './tapewormMongoRangeReader';
export {
  createTapewormCompleteCommitRangeReader,
  type TapewormIndexedCommit,
  type TapewormIndexedCommitRangeCapability
} from './tapewormRangeReader';
