// Downstream replication contracts — public API surface

export type {
  DownstreamEvent,
  EventStreamSnapshot,
  EventStreamEvents,
  EventStreamAdded,
  EventStreamRemoved,
  EventStreamEnvelope,
} from './event-stream-envelope';

export type {
  ProjectionSnapshot,
  ProjectionDelta,
  ProjectionRemoved,
  ProjectionEnvelope,
} from './projection-envelope';

export type {
  ConfigSnapshot,
  ConfigDelta,
  ConfigEnvelope,
} from './config-envelope';

export type {
  EventStreamFeedInput,
  ProjectionFeedInput,
  ConfigFeedInput,
  DownstreamSyncService,
} from './feed-contracts';

export {
  type FeedEnvelopeListener,
  type FeedConsumerOptions,
  type EnvelopeProcessResult,
  type ConsumeResult,
  type EventStreamConsumer,
  createEventStreamConsumer,
} from './feed-consumer';
