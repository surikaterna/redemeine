export interface ProjectionRegistryDefinitionManifest {
  readonly projectionName: string;
  readonly generation: string;
  readonly definitionHash: string;
  readonly sourceSelectors: readonly string[];
}

export interface ProjectionQueueRegistryManifest {
  readonly version: 1;
  readonly manifestId: string;
  readonly queueId: string;
  readonly registryGeneration: string;
  readonly definitions: readonly ProjectionRegistryDefinitionManifest[];
  readonly sourceStartAnchors: Readonly<Record<string, number>>;
}

export interface ProjectionQueueRegistryBinding {
  readonly queueId: string;
  readonly manifestId: string;
  readonly registryGeneration: string;
  readonly boundAt: string;
}

export type ProjectionQueueRegistryBindResult =
  | { status: 'bound' | 'matches'; binding: ProjectionQueueRegistryBinding }
  | { status: 'conflict'; existing: ProjectionQueueRegistryBinding; reason: string };

export interface ProjectionQueueRegistryBindingPort {
  bindImmutableManifest(manifest: ProjectionQueueRegistryManifest): Promise<ProjectionQueueRegistryBindResult>;
  readQueueBinding(queueId: string): Promise<ProjectionQueueRegistryBinding | null>;
}
