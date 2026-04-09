import {
  PROJECTION_WORKER_LITE_GUARANTEE,
  type ProjectionWorkerLiteContract,
  type ProjectionWorkerLiteDecision,
  type ProjectionWorkerLiteMessage,
  type ProjectionWorkerLiteProcessor,
  type ProjectionWorkerLitePushManyResult,
  type ProjectionWorkerLitePushResult
} from './contracts';

function toPushResult(decision: ProjectionWorkerLiteDecision): ProjectionWorkerLitePushResult {
  return {
    guarantee: PROJECTION_WORKER_LITE_GUARANTEE,
    decision
  };
}

async function processMany(
  processor: ProjectionWorkerLiteProcessor,
  messages: readonly ProjectionWorkerLiteMessage[]
): Promise<ProjectionWorkerLitePushManyResult> {
  const items: ProjectionWorkerLitePushResult[] = [];

  for (const message of messages) {
    const decision = await processor(message);
    items.push(toPushResult(decision));
  }

  return {
    guarantee: PROJECTION_WORKER_LITE_GUARANTEE,
    items
  };
}

export function createProjectionWorkerLite(
  processor: ProjectionWorkerLiteProcessor
): ProjectionWorkerLiteContract {
  return {
    async push(message: ProjectionWorkerLiteMessage): Promise<ProjectionWorkerLitePushResult> {
      const decision = await processor(message);
      return toPushResult(decision);
    },
    async pushMany(messages: readonly ProjectionWorkerLiteMessage[]): Promise<ProjectionWorkerLitePushManyResult> {
      return processMany(processor, messages);
    }
  };
}
