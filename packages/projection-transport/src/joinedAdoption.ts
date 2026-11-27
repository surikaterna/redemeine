import { isDeepStrictEqual } from 'node:util';
import { isProjectionSha256Digest } from '@redemeine/projection-runtime-core';
import type { Document } from 'mongodb';
import { collectionNamespace, validateApproval, verifyInitialLinks, type JoinedApproval } from './joinedCutover';
import type { MongoProjectionTransportStoreOptions, ProjectionTransportDocument, ProjectionTransportJoinedAdoptionDocument } from './mongoTransportStore';

type Resources = Pick<MongoProjectionTransportStoreOptions, 'collection' | 'mongoClient' | 'manifest' | 'joinedInventories' | 'joinedApprovals'>;
const majority = { readConcern: { level: 'majority' } } as const;

function adoptionIdentity(resources: Resources, approvalDigest: string): ProjectionTransportJoinedAdoptionDocument {
  const { queueId, manifestId, registryGeneration } = resources.manifest;
  return { _id: `joined_adoption:${queueId}`, kind: 'joined_adoption', queueBindingId: queueId,
    manifestId, registryGeneration, transportNamespace: collectionNamespace(resources.collection), approvalDigest };
}

function assertAdopted(row: ProjectionTransportDocument | null, expected: ProjectionTransportJoinedAdoptionDocument): void {
  if (!row || row.kind !== 'joined_adoption' || !isProjectionSha256Digest(row.approvalDigest)
    || Object.keys(row).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => row[key] !== value)) {
    throw new Error('Joined cutover adoption conflict or unknown insert outcome.');
  }
}

function approvalIdentity(resources: Resources, adoption: ProjectionTransportJoinedAdoptionDocument, approvalNamespace: string) {
  const definitions = resources.manifest.definitions.filter(({ joined }) => joined === true);
  const inventories = resources.joinedInventories ?? [];
  if (inventories.length !== definitions.length) throw new Error('Joined approval scope count mismatch.');
  const scopes = definitions.map(({ projectionName, generation, joinMembership }, index) => {
    const item = inventories[index]!;
    if (item.projectionName !== projectionName || item.generation !== generation) throw new Error('Joined approval resource scope mismatch.');
    return { projectionName, generation, linkNamespace: collectionNamespace(item.links), documentNamespace: collectionNamespace(item.documents),
      formatType: joinMembership === undefined ? 'missing' : 'string', format: joinMembership ?? null };
  });
  const { queueBindingId, manifestId, registryGeneration, transportNamespace, approvalDigest } = adoption;
  return { _id: `joined_approval:${queueBindingId}`, kind: 'joined_approval', queueBindingId, manifestId,
    registryGeneration, approvalNamespace, transportNamespace, digest: approvalDigest, scopes };
}

function identityStrings(values: Record<string, string | null>, path: string): Document {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => {
    const actual = `${path}${field}`;
    // Never return unexpected types or large malformed fields from an approval document.
    return [field, { $cond: [{ $eq: [{ $type: actual }, 'string'] },
      { $cond: [{ $eq: [{ $strLenBytes: actual }, Buffer.byteLength(value ?? '')] }, actual, null] }, null] }];
  }));
}

function identityProjection({ scopes, ...header }: ReturnType<typeof approvalIdentity>): Document {
  const scopeValues = scopes.map(({ formatType: _formatType, ...values }, index) => ({
    $let: { vars: { scope: { $arrayElemAt: ['$inventories', index] } },
      in: { ...identityStrings(values, '$$scope.'), formatType: { $type: '$$scope.format' } } }
  }));
  return { ...identityStrings(header, '$'), scopes: { $cond: [
    { $isArray: '$inventories' },
    { $cond: [{ $eq: [{ $size: '$inventories' }, scopes.length] }, scopeValues, null] },
    null
  ] } };
}

async function adopt(resources: Resources, approval: JoinedApproval, expected: ProjectionTransportJoinedAdoptionDocument): Promise<void> {
  const session = resources.mongoClient.startSession();
  try {
    await session.withTransaction(async () => {
      const persisted = await resources.joinedApprovals?.findOne({ _id: approval._id }, { session });
      if (!persisted || persisted.kind !== 'joined_approval' || JSON.stringify(persisted) !== JSON.stringify(approval)) {
        throw new Error('Joined approval changed during adoption.');
      }
      if (await resources.collection.findOne({ _id: expected._id }, { session })) return;
      for (const [index, item] of approval.inventories.entries()) {
        await verifyInitialLinks(item, resources.joinedInventories![index]!, session);
      }
      await resources.collection.insertOne(expected, { session });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } catch (error) {
    // A concurrent adopter can win the insert. Only its matching majority record authorizes this worker.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        assertAdopted(await resources.collection.findOne({ _id: expected._id }, majority), expected);
        return;
      } catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function verifyJoinedAdoption(resources: Resources, verifySetCollations: () => Promise<void>): Promise<void> {
  const inventories = resources.joinedInventories ?? [];
  if (!resources.manifest.definitions.some(({ joined }) => joined === true)) {
    if (inventories.length) throw new Error('Unexpected joined resources without joined definitions.');
    return;
  }
  const { joinedApprovals, manifest, collection } = resources;
  if (!joinedApprovals) throw new Error('Missing durable joined approval collection.');
  const approvalNamespace = collectionNamespace(joinedApprovals);
  const prior = await collection.findOne({ _id: `joined_adoption:${manifest.queueId}` }, majority);
  if (prior) {
    const expected = adoptionIdentity(resources, prior.approvalDigest);
    assertAdopted(prior, expected);
    const identity = approvalIdentity(resources, expected, approvalNamespace);
    // Use the collection's collation for its _id index, never for identity equality. The operator-owned seed stays immutable.
    const match = await joinedApprovals.findOne({ _id: identity._id }, { ...majority, projection: identityProjection(identity) });
    if (!isDeepStrictEqual(match, identity)) throw new Error('Joined approval identity differs from durable adoption.');
    await verifySetCollations();
    return;
  }
  const approval = await joinedApprovals.findOne({ _id: `joined_approval:${manifest.queueId}` }, majority);
  validateApproval(manifest, approval, inventories, collectionNamespace(collection), approvalNamespace);
  await verifySetCollations();
  const expected = adoptionIdentity(resources, approval.digest);
  await adopt(resources, approval, expected);
  assertAdopted(await collection.findOne({ _id: expected._id }, majority), expected);
}
