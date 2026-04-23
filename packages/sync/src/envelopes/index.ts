// Sync envelope types — convenience re-exports

export type {
  DownstreamEvent,
  EventStreamSnapshot,
  EventStreamEvents,
  EventStreamAdded,
  EventStreamRemoved,
  EventStreamEnvelope,
} from '../downstream/event-stream-envelope';

export type {
  ProjectionSnapshot,
  ProjectionDelta,
  ProjectionRemoved,
  ProjectionEnvelope,
} from '../downstream/projection-envelope';

export type {
  ConfigSnapshot,
  ConfigDelta,
  ConfigEnvelope,
} from '../downstream/config-envelope';
