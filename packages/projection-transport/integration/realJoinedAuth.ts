import { randomBytes } from 'node:crypto';
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { JoinedApproval } from '../src';

export interface JoinedAuthFixture {
  readonly operator: MongoClient;
  readonly worker: MongoClient;
  readonly secondWorker: MongoClient;
  readonly operatorDb: Db;
  readonly workerDb: Db;
  readonly secondWorkerDb: Db;
}

function credentialUri(rootUri: string, username: string, password: string, database: string): string {
  const uri = new URL(rootUri);
  uri.username = username;
  uri.password = password;
  uri.searchParams.set('authSource', database);
  return uri.toString();
}

export async function createJoinedUsers(root: MongoClient, rootUri: string, database: string): Promise<JoinedAuthFixture> {
  const db = root.db(database);
  const operatorPassword = randomBytes(24).toString('hex');
  const workerPassword = randomBytes(24).toString('hex');
  const collectionActions = ['find', 'insert', 'update', 'remove', 'createIndex', 'listIndexes'];
  const collections = ['A_documents', 'A_links', 'A_dedupe', 'A_transport',
    'B_documents', 'B_links', 'B_dedupe', 'B_transport',
    'M1_documents', 'M1_links', 'M2_documents', 'M2_links', 'multi_transport', 'multi_dedupe'];
  await db.createCollection('joined_approvals');
  for (const collection of collections) await db.createCollection(collection);
  await db.command({ createRole: 'zz6h-approval-provisioner', privileges: [
    { resource: { db: database, collection: 'joined_approvals' }, actions: ['find', 'insert'] },
    ...collections.filter((collection) => collection.endsWith('_links')).map((collection) => ({
      resource: { db: database, collection }, actions: ['find', 'insert', 'update'] })),
    ...collections.filter((collection) => collection.endsWith('_documents')).map((collection) => ({
      resource: { db: database, collection }, actions: ['find'] }))
  ], roles: [] });
  await db.command({ createRole: 'zz6h-worker', privileges: [
    { resource: { db: database, collection: 'joined_approvals' }, actions: ['find'] },
    ...collections.map((collection) => ({ resource: { db: database, collection }, actions: collectionActions }))
  ], roles: [] });
  await db.command({ createUser: 'zz6h-operator', pwd: operatorPassword,
    roles: [{ role: 'zz6h-approval-provisioner', db: database }] });
  await db.command({ createUser: 'zz6h-worker', pwd: workerPassword,
    roles: [{ role: 'zz6h-worker', db: database }] });
  const operator = new MongoClient(credentialUri(rootUri, 'zz6h-operator', operatorPassword, database));
  const workerUri = credentialUri(rootUri, 'zz6h-worker', workerPassword, database);
  const worker = new MongoClient(workerUri);
  const secondWorker = new MongoClient(workerUri);
  await Promise.all([operator.connect(), worker.connect(), secondWorker.connect()]);
  return { operator, worker, secondWorker, operatorDb: operator.db(database), workerDb: worker.db(database),
    secondWorkerDb: secondWorker.db(database) };
}

function unauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 13;
}

export async function verifyWorkerApprovalRights(approvals: Collection<JoinedApproval>, id: string): Promise<void> {
  const before = await approvals.findOne({ _id: id });
  if (!before) throw new Error('Worker could not read provisioned approval.');
  const writes = [
    () => approvals.insertOne({ ...before, _id: `joined_approval:unauthorized-${Date.now()}` }),
    () => approvals.updateOne({ _id: id }, { $set: { approvedBy: 'worker-tampered' } }),
    () => approvals.deleteOne({ _id: id })
  ];
  for (const write of writes) {
    let denied = false;
    try { await write(); } catch (error) { denied = unauthorized(error); }
    if (!denied) throw new Error('Worker approval write was not denied by Mongo authorization.');
  }
  if (JSON.stringify(await approvals.findOne({ _id: id })) !== JSON.stringify(before)) {
    throw new Error('Worker changed the provisioned approval despite denied writes.');
  }
}

export async function verifyOperatorWriteOnce(approvals: Collection<JoinedApproval>, approval: JoinedApproval): Promise<void> {
  const prior = await approvals.findOne({ _id: approval._id });
  if (JSON.stringify(prior) !== JSON.stringify(approval)) throw new Error('Operator approval insert/readback mismatch.');
  let duplicate = false;
  try { await approvals.insertOne({ ...approval, approvedBy: 'conflicting-operator' }); } catch (error) {
    duplicate = typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
  }
  if (!duplicate) throw new Error('Conflicting operator approval insert was not rejected.');
  for (const write of [
    () => approvals.updateOne({ _id: approval._id }, { $set: { approvedBy: 'operator-overwrite' } }),
    () => approvals.deleteOne({ _id: approval._id })
  ]) {
    let denied = false;
    try { await write(); } catch (error) { denied = unauthorized(error); }
    if (!denied) throw new Error('Operator approval overwrite/delete was not denied.');
  }
  if (JSON.stringify(await approvals.findOne({ _id: approval._id })) !== JSON.stringify(approval)) {
    throw new Error('Operator write-once approval was changed.');
  }
}
