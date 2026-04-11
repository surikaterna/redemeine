// Sync manifest contracts — barrel exports

// Lanes
export type { SyncLane } from './lanes';
export { SYNC_LANES } from './lanes';

// Selectors
export type {
  SelectorFilter,
  EventStreamSelector,
  ProjectionSelector,
  MasterDataSelector,
  ConfigurationSelector,
  LaneSelector,
} from './selectors';
export { selectorIdentityKey } from './selectors';

// Manifest
export type { SyncManifest, ManifestByLane } from './manifest';
export { groupSelectorsByLane } from './manifest';

// Delta
export type { ManifestDelta } from './delta';
export { computeManifestDelta } from './delta';

// Lifecycle signals
export type {
  StreamAddedSignal,
  StreamRemovedSignal,
  ManifestLifecycleSignal,
} from './lifecycle';
export { deriveLifecycleSignals } from './lifecycle';

// Rule engine
export type { RuleContext, IManifestRuleEngine } from './rule-engine';

// Manifest store
export type { IManifestStore } from './manifest-store';

// Hierarchy
export { deriveChildManifest } from './hierarchy';
