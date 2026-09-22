import { defineProjectionSourceCommitStoreConformance } from '../../projection-runtime-core/test/sourceCommitStoreConformance';
import { MongoProjectionStore } from '../src';
import {
  createFakeMongoClient,
  createProjectionDedupeCollection,
  createProjectionDocumentCollection,
  createProjectionLinkCollection
} from './mocks';

let dedupe = createProjectionDedupeCollection();

defineProjectionSourceCommitStoreConformance(
  'Mongo',
  () => {
    dedupe = createProjectionDedupeCollection();
    return new MongoProjectionStore({
      collection: createProjectionDocumentCollection<{ value: number }>(),
      linkCollection: createProjectionLinkCollection(),
      dedupeCollection: dedupe,
      mongoClient: createFakeMongoClient()
    });
  },
  () => dedupe.operationLog.length
);
