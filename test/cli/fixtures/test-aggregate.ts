import { createAggregate } from '@redemeine/aggregate';
import { Event } from '@redemeine/kernel';
import { z } from 'zod';

// --- Shared types with explicit Zod schemas (z.infer link) ---

export const identifierSchema = z.object({
  identifier: z.string(),
  domain: z.string(),
  authority: z.string(),
});
export type Identifier = z.infer<typeof identifierSchema>;

// --- Shared types without Zod schemas (pure TS) ---

export interface Summary {
  fileName?: string;
  mimeType?: string;
  bytes?: number;
}

export interface Property {
  key: string;
  value: string;
  authority?: string;
}

export interface Source {
  source: string;
  downloadKey: string;
}

// --- State with diverse type patterns ---

export interface TestState {
  id: string;
  status: 'pending' | 'active' | 'closed';
  summary: Summary;
  owner: Identifier;
  properties: Property[];
  sources: Source[];
  metadata: Record<string, string>;
  pendingSource?: Source;
  tags: string[];
  count: number;
  isActive: boolean;
  deletedAt: string | null;
  createdAt: string;
}

const initialState: TestState = {
  id: '',
  status: 'pending',
  summary: {},
  owner: { identifier: '', domain: '', authority: '' },
  properties: [],
  sources: [],
  metadata: {},
  tags: [],
  count: 0,
  isActive: false,
  deletedAt: null,
  createdAt: '',
};

// --- Aggregate definition ---

export const testAggregate = createAggregate<TestState, 'test'>('test', initialState)
  .events({
    registered: (state, event: Event<{
      id: string;
      summary: Summary;
      owner: Identifier;
      properties: Property[];
      status: 'pending';
    }>) => {
      state.id = event.payload.id;
      state.summary = event.payload.summary;
      state.owner = event.payload.owner;
      state.properties = event.payload.properties;
      state.status = event.payload.status;
    },
    deregistered: (state, event: Event<{ status: 'closed' }>) => {
      state.status = event.payload.status;
    },
    sourceAdded: (state, event: Event<{ source: string; downloadKey: string }>) => {
      state.sources.push(event.payload);
    },
    summaryAmended: (state, event: Event<{ summary: Summary }>) => {
      state.summary = event.payload.summary;
    },
    tagged: (state, event: Event<{ tags: string[] }>) => {
      state.tags = event.payload.tags;
    },
    metadataSet: (state, event: Event<{ metadata: Record<string, string> }>) => {
      state.metadata = event.payload.metadata;
    },
    cleared: (state) => {
      state.status = 'closed';
    },
    nullableUpdated: (state, event: Event<{ deletedAt: string | null }>) => {
      state.deletedAt = event.payload.deletedAt;
    }
  })
  .commands((emit) => ({
    register: {
      pack: (id: string, summary: Summary, owner: Identifier, properties?: Property[]) => ({
        id, summary, owner, properties: properties ?? []
      }),
      handler: (state, payload) => emit.registered({ ...payload, status: 'pending' as const })
    },
    deregister: (state) => emit.deregistered({ status: 'closed' as const }),
    addSource: (state, payload: { source: string; downloadKey: string }) => emit.sourceAdded(payload),
    amendSummary: (state, payload: { summary: Summary }) => emit.summaryAmended(payload),
    tag: (state, payload: { tags: string[] }) => emit.tagged(payload),
    setMetadata: (state, payload: { metadata: Record<string, string> }) => emit.metadataSet(payload),
    clear: () => emit.cleared(),
    updateNullable: (state, payload: { deletedAt: string | null }) => emit.nullableUpdated(payload),
  }))
  .build();
