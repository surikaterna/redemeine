import type { CursorStoreContract, ProjectionCursor } from '../contracts/cursorStore';

function cloneCursor(cursor: ProjectionCursor): ProjectionCursor {
  return {
    projectionName: cursor.projectionName,
    checkpoint: {
      sequence: cursor.checkpoint.sequence,
      timestamp: cursor.checkpoint.timestamp
    }
  };
}

export class InMemoryCursorStoreAdapter implements CursorStoreContract {
  private readonly cursors = new Map<string, ProjectionCursor>();

  async load(projectionName: string): Promise<ProjectionCursor | null> {
    const cursor = this.cursors.get(projectionName);
    return cursor ? cloneCursor(cursor) : null;
  }

  async save(cursor: ProjectionCursor): Promise<void> {
    this.cursors.set(cursor.projectionName, cloneCursor(cursor));
  }

  getSnapshot(): Map<string, ProjectionCursor> {
    return new Map(
      [...this.cursors.entries()].map(([projectionName, cursor]) => [projectionName, cloneCursor(cursor)])
    );
  }

  clear(): void {
    this.cursors.clear();
  }
}
