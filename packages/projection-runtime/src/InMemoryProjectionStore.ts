import type { ProjectionCheckpoint } from './contracts/commitFeed';

export interface IProjectionStore<TState extends Record<string, unknown> = Record<string, unknown>> {
  load(documentId: string): Promise<TState | null>;
  save(documentId: string, state: TState, checkpoint: ProjectionCheckpoint): Promise<void>;
  getCheckpoint(key: string): Promise<ProjectionCheckpoint | null>;
}

const CURSOR_PREFIX = '__cursor__';

function parseCursorProjectionName(key: string): string | null {
  if (!key.startsWith(CURSOR_PREFIX)) {
    return null;
  }

  const projectionName = key.slice(CURSOR_PREFIX.length).trim();
  return projectionName.length > 0 ? projectionName : null;
}

export class InMemoryProjectionStore<TState extends Record<string, unknown> = Record<string, unknown>>
  implements IProjectionStore<TState>
{
  private readonly documents = new Map<string, { state: TState; checkpoint: ProjectionCheckpoint }>();

  async load(documentId: string): Promise<TState | null> {
    const document = this.documents.get(documentId);
    return document ? document.state : null;
  }

  async save(documentId: string, state: TState, checkpoint: ProjectionCheckpoint): Promise<void> {
    this.documents.set(documentId, {
      state,
      checkpoint
    });
  }

  async getCheckpoint(key: string): Promise<ProjectionCheckpoint | null> {
    const document = this.documents.get(key);
    if (document) {
      return document.checkpoint;
    }

    const projectionName = parseCursorProjectionName(key);
    if (!projectionName) {
      return null;
    }

    const legacyCursorDoc = this.documents.get('__cursor__');
    return legacyCursorDoc?.checkpoint ?? null;
  }
}
