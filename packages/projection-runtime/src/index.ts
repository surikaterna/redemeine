export type {
  CommitFeedBatch,
  CommitFeedContract,
  ProjectionCommit,
  ProjectionCheckpoint
} from './contracts/commitFeed';

export type {
  CursorStoreContract,
  ProjectionCursor
} from './contracts/cursorStore';

export type {
  LinkStoreContract,
  ProjectionLink,
  ProjectionLinkKey
} from './contracts/linkStore';

export type {
  DocumentProjectionPersistenceContract,
  PatchProjectionPersistenceContract,
  PersistProjectionDocument,
  PersistProjectionPatch,
  ProjectedDocument,
  ProjectionMetadataEnvelope,
  ProjectionReadContract,
  Rfc6902Operation
} from './contracts/persistence';

export type {
  ProjectionVersionAvailableNotification,
  VersionNotifierContract
} from './contracts/versionNotifier';

export {
  InMemoryProjectionPersistenceAdapter,
  persistProjectedState
} from './persistence/InMemoryProjectionPersistenceAdapter';

export {
  buildProjectionMetadata,
  withProjectionMetadata
} from './persistence/metadata';

export {
  resolveProjectionPersistence,
  type ProjectionPersistenceCapabilities,
  type ProjectionPersistenceMode,
  type ResolvedProjectionPersistence
} from './persistence/modeSelection';
