export interface IProjectionLinkStore {
  addLink(aggregateType: string, aggregateId: string, targetDocId: string): Promise<void> | void;
  resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> | string | null;
  removeLinksForTarget?(targetDocId: string): Promise<void> | void;
}
