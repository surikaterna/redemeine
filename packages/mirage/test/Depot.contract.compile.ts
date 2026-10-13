import type { EventStore } from '../src/Depot';

const _validStore: EventStore = {
  readStream: async function* (_id: string) {},
  saveEvents: async () => undefined
};

const _validStoreWithResumeOptions: EventStore = {
  readStream: async function* (_id: string, options?: { fromVersion?: number }) {
    void options?.fromVersion;
  },
  saveEvents: async () => undefined
};

const _legacyPromiseAdapter: EventStore = {
  // @ts-expect-error EventStore.readStream must return AsyncIterable<Event>, not Promise<Event[]>
  readStream: async (_id: string) => [],
  saveEvents: async () => undefined
};

void _validStore;
void _validStoreWithResumeOptions;
void _legacyPromiseAdapter;
