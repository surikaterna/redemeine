import { IProjectionLinkStore } from './IProjectionLinkStore';

export class InMemoryProjectionLinkStore implements IProjectionLinkStore {
  private links = new Map<string, string>();

  addLink(aggregateType: string, aggregateId: string, targetDocId: string): void {
    const key = this.makeKey(aggregateType, aggregateId);
    if (!this.links.has(key)) {
      this.links.set(key, targetDocId);
    }
  }

  resolveTarget(aggregateType: string, aggregateId: string): string | null {
    return this.links.get(this.makeKey(aggregateType, aggregateId)) ?? null;
  }

  removeLinksForTarget(targetDocId: string): void {
    for (const [key, value] of this.links.entries()) {
      if (value === targetDocId) {
        this.links.delete(key);
      }
    }
  }

  private makeKey(aggregateType: string, aggregateId: string): string {
    return `${aggregateType}:${aggregateId}`;
  }
}
