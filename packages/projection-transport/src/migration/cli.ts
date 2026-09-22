#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { runMigrationCliCommand } from './cliExecution';
import { loadProjectionMigrationRuntimeArtifact } from './runtimeArtifact';
import { assertRuntimeMatchesManifest } from './runtimeIdentity';
import { PROJECTION_MIGRATION_MAX_MANIFEST_BYTES, parseProjectionMigrationManifest } from './validate';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function required(name: string): string {
  const value = option(name) ?? process.env[name.replace(/^--/, '').replaceAll('-', '_').toUpperCase()];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const manifestFile = required('--manifest');
  if ((await stat(manifestFile)).size > PROJECTION_MIGRATION_MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the supported 8 MiB bound.');
  const manifestText = await readFile(manifestFile, 'utf8');
  const manifest = parseProjectionMigrationManifest(JSON.parse(manifestText) as unknown, Buffer.byteLength(manifestText));
  const runtime = await loadProjectionMigrationRuntimeArtifact(required('--runtime-module'));
  assertRuntimeMatchesManifest(runtime.module, manifest.newRegistry, manifest.destinationStrategies, runtime.digest);
  const targetClient = new MongoClient(required('--mongo-uri'));
  const sourceClient = new MongoClient(required('--source-mongo-uri'));
  await Promise.all([targetClient.connect(), sourceClient.connect()]);
  try {
    const receipt = await runMigrationCliCommand({
      command: process.argv[2],
      manifest,
      runtime,
      targetClient,
      sourceClient,
      required,
      dryRun: process.argv.includes('--dry-run')
    });
    await runtime.verifyUnchanged();
    output(receipt);
  } finally {
    await Promise.all([targetClient.close(), sourceClient.close()]);
  }
}

function output(value: { status: string }): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  if (value.status !== 'ok') process.exitCode = 1;
}
main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ version: 2, status: 'rejected', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
