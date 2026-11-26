import { defineProjectionChangesStoreConformance } from '../../projection-runtime-core/test/projectionChangesStoreConformance';
import { InMemoryProjectionStore } from '../src';

defineProjectionChangesStoreConformance('in-memory', () => {
  const store = new InMemoryProjectionStore<{ value: number; kept?: string }>();
  return { store, records: () => store.getProjectionChanges() };
});
