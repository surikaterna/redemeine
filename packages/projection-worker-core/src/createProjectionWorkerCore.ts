import type {
  ProjectionWorkerCommit,
  ProjectionWorkerDecision,
  ProjectionWorkerProcessingMetadata,
  ProjectionWorkerProcessor,
  ProjectionWorkerPushContract,
  ProjectionWorkerPushManyResult,
  ProjectionWorkerPushResult,
  ProjectionWorkerResultItem,
  ProjectionWorkerTransportMetadata
} from './contracts';

const DEFAULT_PRIORITY = 0;
const DEFAULT_RETRY_COUNT = 0;

function normalizeMetadata(
  metadata: ProjectionWorkerTransportMetadata | undefined
): ProjectionWorkerProcessingMetadata {
  return {
    priority: metadata?.priority ?? DEFAULT_PRIORITY,
    retryCount: metadata?.retryCount ?? DEFAULT_RETRY_COUNT
  };
}

function toResultItem(
  commit: ProjectionWorkerCommit,
  metadata: ProjectionWorkerProcessingMetadata,
  decision: ProjectionWorkerDecision
): ProjectionWorkerResultItem {
  return {
    definition: commit.definition,
    message: commit.message,
    metadata,
    decision
  };
}

async function processCommit(
  processor: ProjectionWorkerProcessor,
  commit: ProjectionWorkerCommit
): Promise<ProjectionWorkerResultItem> {
  const metadata = normalizeMetadata(commit.metadata);
  const decision = await processor({
    commit,
    metadata
  });

  return toResultItem(commit, metadata, decision);
}

async function processMany(
  processor: ProjectionWorkerProcessor,
  commits: readonly ProjectionWorkerCommit[]
): Promise<ProjectionWorkerPushManyResult> {
  const items: ProjectionWorkerResultItem[] = [];

  for (const commit of commits) {
    const item = await processCommit(processor, commit);
    items.push(item);
  }

  return {
    items
  };
}

export function createProjectionWorkerCore(
  processor: ProjectionWorkerProcessor
): ProjectionWorkerPushContract {
  return {
    async push(commit: ProjectionWorkerCommit): Promise<ProjectionWorkerPushResult> {
      const item = await processCommit(processor, commit);
      return {
        item
      };
    },
    async pushMany(commits: readonly ProjectionWorkerCommit[]): Promise<ProjectionWorkerPushManyResult> {
      return processMany(processor, commits);
    }
  };
}
