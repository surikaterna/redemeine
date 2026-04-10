import type { ProjectionCheckpoint } from './commitFeed';

export interface ProjectionCursor {
  projectionName: string;
  checkpoint: ProjectionCheckpoint;
}

export interface CursorStoreContract {
  load(projectionName: string): Promise<ProjectionCursor | null>;
  save(cursor: ProjectionCursor): Promise<void>;
}
