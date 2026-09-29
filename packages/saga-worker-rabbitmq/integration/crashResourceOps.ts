import type { MongoClient } from 'mongodb';
import { required } from './crashBroker';
import { deriveOwnedNames, inspectUserTags, removeOwnedUser, type UserOwnerEvidence } from './crashNames';
import { OwnerMismatchError, type OwnedNames, type OwnedOps } from './crashOwnership';

const adminUser = required('REDEMEINE_RABBIT_USER');
const adminPassword = required('REDEMEINE_RABBIT_PASSWORD');
const markerFor = (names: OwnedNames) => `owned_${names.vhost}`;

async function admin(path: string, method: string, body?: object): Promise<Response> {
  const auth = Buffer.from(`${adminUser}:${adminPassword}`).toString('base64');
  const response = await fetch(new URL(path, required('REDEMEINE_RABBIT_MANAGEMENT_URL')), {
    method, headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5_000), ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw new Error(`admin HTTP ${response.status}`);
  return response;
}

function path(kind: 'vhosts' | 'users', name: string): string {
  return `/api/${kind}/${encodeURIComponent(name)}`;
}

async function probe(kind: 'vhosts' | 'users', name: string): Promise<Response | null> {
  return admin(path(kind, name), 'GET').catch((error: unknown) => {
    if (error instanceof Error && error.message === 'admin HTTP 404') return null;
    throw error;
  });
}

async function userOwnership(name: string, marker: string): Promise<UserOwnerEvidence> {
  const tags = await readUserTags(name);
  return inspectUserTags(tags, marker);
}

async function readUserTags(name: string): Promise<unknown | null> {
  const response = await probe('users', name);
  if (!response) return null;
  const value: unknown = await response.json();
  return typeof value === 'object' && value !== null && 'tags' in value ? value.tags : undefined;
}

async function removeRabbit(kind: 'vhosts' | 'users', name: string, marker: string): Promise<'removed' | 'absent'> {
  if (kind === 'users') return removeOwnedUser(marker, () => readUserTags(name),
    async () => { await admin(path(kind, name), 'DELETE'); }, async () => !await probe(kind, name));
  const response = await probe(kind, name);
  if (!response) return 'absent';
  const value: unknown = await response.json();
  const owned = typeof value === 'object' && value !== null && 'description' in value && value.description === marker;
  if (!owned) throw new OwnerMismatchError();
  await admin(path(kind, name), 'DELETE');
  if (await probe(kind, name)) throw new Error('owned Rabbit resource remains');
  return 'removed';
}

async function databaseExists(client: MongoClient, name: string): Promise<boolean> {
  const databases = await client.db().admin().listDatabases({ nameOnly: true, filter: { name } });
  return databases.databases.some(db => db.name === name);
}

export async function createDbOwner(client: MongoClient, names: OwnedNames): Promise<void> {
  await client.db(names.db).collection<{ _id: string; marker: string }>('__crash_owner')
    .insertOne({ _id: 'run', marker: markerFor(names) });
}

export function ownedOps(names: OwnedNames, client: MongoClient, password: string): OwnedOps {
  const marker = markerFor(names);
  return {
    absent: async (kind, name) => kind === 'db' ? !await databaseExists(client, name) :
      (await probe(kind === 'vhost' ? 'vhosts' : 'users', name)) === null,
    createVhost: async name => { await admin(path('vhosts', name), 'PUT', { description: marker }); },
    createUser: async name => { await admin(path('users', name), 'PUT', { password, tags: `monitoring,${marker}` }); },
    inspectUser: name => userOwnership(name, marker),
    grant: async (vhost, user) => { await admin(`/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(user)}`,
      'PUT', { configure: '.*', write: '.*', read: '.*' }); },
    removeVhost: name => removeRabbit('vhosts', name, marker),
    removeUser: name => removeRabbit('users', name, marker),
    removeDb: async name => {
      if (!await databaseExists(client, name)) return 'absent';
      const record = await client.db(name).collection<{ _id: string; marker: string }>('__crash_owner')
        .findOne({ _id: 'run' });
      if (record?.marker !== marker) throw new OwnerMismatchError();
      await client.db(name).dropDatabase();
      if (await databaseExists(client, name)) throw new Error('owned database remains');
      return 'removed';
    }
  };
}

export function ownedEnvironment(names: OwnedNames, password: string): NodeJS.ProcessEnv {
  const id = required('REDEMEINE_REAL_RUN_ID');
  const { owned, mongo } = deriveOwnedNames(id);
  if (names.db !== owned.db || names.user !== owned.user || names.vhost !== owned.vhost) {
    throw new TypeError('owned resource names do not match run identity');
  }
  const { vhost, user } = names;
  const url = new URL(required('REDEMEINE_RABBIT_URL'));
  url.username = user;
  url.password = password;
  url.pathname = `/${vhost}`;
  return { REDEMEINE_CRASH_VHOST: vhost, REDEMEINE_CRASH_URL: url.toString(),
    REDEMEINE_RABBIT_USER: user, REDEMEINE_RABBIT_PASSWORD: password,
    REDEMEINE_CRASH_DB: mongo.db, REDEMEINE_CRASH_SAGA_PARTITION: mongo.sagaPartition,
    REDEMEINE_CRASH_PARTITION: mongo.sourcePartition, REDEMEINE_CRASH_COLLECTION: mongo.sourceCollection,
    REDEMEINE_CRASH_EXCHANGE: `source.${id}` };
}
