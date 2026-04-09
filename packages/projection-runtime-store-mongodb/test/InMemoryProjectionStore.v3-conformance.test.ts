import { describe } from 'bun:test';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { runV3StoreConformance } from './v3StoreConformanceHarness';

describe('shared v3 conformance', () => {
  runV3StoreConformance('inmemory', () => new InMemoryProjectionStore<Record<string, unknown>>());
});
