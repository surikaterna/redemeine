export interface ProjectionLinkKey {
  aggregateType: string;
  aggregateId: string;
}

export interface ProjectionLink {
  key: ProjectionLinkKey;
  targetDocumentId: string;
}

export interface LinkStoreContract {
  add(link: ProjectionLink): Promise<void>;
  removeForTarget(targetDocumentId: string): Promise<void>;
  resolveTargets(key: ProjectionLinkKey): Promise<string[]>;
}
