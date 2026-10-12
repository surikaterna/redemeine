import { createProjectionLaneScheduler } from '../../projection-worker-core/src/targetLaneScheduler';
import { executeProjectionDefinition } from '../../projection-worker-core/src/projectionDefinitionExecutor';
import { liveCommit, liveDefinition } from '../../projection-worker-core/test/liveFixtures';
import { MongoProjectionStore } from '../src';
import { createFakeMongoClient, createProjectionDedupeCollection, createProjectionDocumentCollection, createProjectionLinkCollection } from './mocks';

test('live own_record F42 executes against Mongo store without accepted baseline seed', async () => {
  const dedupe = createProjectionDedupeCollection();
  const documents = createProjectionDocumentCollection<{ count: number }>();
  const store = new MongoProjectionStore({ collection: documents, dedupeCollection: dedupe,
    linkCollection: createProjectionLinkCollection(), mongoClient: createFakeMongoClient() });
  await store.initializeProjectionSourceCommitStore();
  const options = { definition: liveDefinition('counter', 'own_record'), generation: 'live', store,
    lanes: createProjectionLaneScheduler(), maxConflictRetries: 1, liveProfile: { coveredDuplicate: false, assertCurrent: () => {} } };
  expect((await executeProjectionDefinition(options, liveCommit(42))).status).toBe('committed');
  expect((await executeProjectionDefinition(options, liveCommit(42))).status).toBe('deduplicated');
  expect(dedupe.snapshot()).toHaveLength(1);
  expect(dedupe.snapshot()[0]).toMatchObject({ commitSequence: 42 });
  expect(dedupe.snapshot()[0]).not.toHaveProperty('acceptedBaselineSequence');
  expect(documents.snapshot()[0]?.state).toEqual({ count: 1 });
});
