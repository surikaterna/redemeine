#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { MongoProjectionTransportStore, type ProjectionTransportDocument } from '../mongoTransportStore';
import { ProjectionMigrationEngine } from './engine';
import { MongoProjectionMigrationRegistryPort, MongoProjectionMigrationStatePort } from './mongoPorts';
import {
  parseProjectionMigrationManifest, parseProjectionMigrationQuiesceEvidence, parseProjectionMigrationReplayEvidence, parseProjectionMigrationVerification
} from './validate';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function jsonFile(path: string | undefined): Promise<unknown> {
  if (!path) throw new Error('Required JSON file option is missing.');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function booleanOption(name: string): boolean {
  const value = option(name);
  return value === 'true';
}

async function run(): Promise<void> {
  const command = process.argv[2];
  const manifest = parseProjectionMigrationManifest(await jsonFile(option('--manifest')));
  if (command === 'preflight' && process.argv.includes('--dry-run')) {
    return print({ version: 1, command: 'preflight', migrationId: manifest.migrationId, manifestDigest: manifest.manifestDigest,
      status: 'ok', phase: null, revision: null, mutated: false, reasons: [] });
  }
  const uri = option('--mongo-uri') ?? process.env.MONGODB_URI;
  if (!uri) throw new Error('--mongo-uri or MONGODB_URI is required.');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const database = client.db(option('--database') ?? 'redemeine');
    const states = new MongoProjectionMigrationStatePort(database.collection('projection_migrations'));
    await states.initialize();
    const transport = new MongoProjectionTransportStore({ collection: database.collection<ProjectionTransportDocument>('projection_transport'), mongoClient: client, manifest: manifest.newRegistry });
    const engine = new ProjectionMigrationEngine(states, new MongoProjectionMigrationRegistryPort(transport));
    if (command === 'preflight') return print(await engine.preflight(manifest));
    if (command === 'quiesce') return print(await engine.quiesce(manifest, parseProjectionMigrationQuiesceEvidence(await jsonFile(option('--evidence')))));
    if (command === 'activate' || command === 'adopt') return print(await engine.activate(manifest, parseProjectionMigrationReplayEvidence(await jsonFile(option('--evidence')))));
    if (command === 'verify') return print(await engine.verify(manifest, parseProjectionMigrationVerification(await jsonFile(option('--evidence')))));
    if (command === 'rollback') return print(await engine.rollback(manifest, option('--reason') ?? 'operator rollback', booleanOption('--old-feed-available'), booleanOption('--conflicting-writes')));
    throw new Error('Expected command: preflight, quiesce, activate, adopt, verify, or rollback.');
  } finally {
    await client.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ version: 1, status: 'rejected', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
