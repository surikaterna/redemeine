import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const files = [
  'packages/projection-runtime-core/src/contracts/sourceCommitStore.ts',
  'packages/projection-runtime-core/src/index.ts',
  'packages/projection-worker-core/src/createProjectionCommitCoordinator.ts',
  'packages/projection-worker-core/src/projectionDefinitionExecutor.ts',
  'packages/projection-runtime-store-inmemory/src/internal/sourceCommitV2.ts',
  'packages/projection-runtime-store-mongodb/src/store/sourceCommitV2.ts',
  'packages/projection-transport/src/index.ts'
];

test('live public contracts and stores have no rebuild receipt hooks', () => {
  for (const file of files) {
    expect(readFileSync(resolve(root, file), 'utf8')).not.toMatch(/ProjectionMigration|migrationReceipt|migrationReplay/);
  }
  const removed = resolve(root, 'packages/projection-transport/src/migration');
  expect(!existsSync(removed) || readdirSync(removed).length === 0).toBe(true);
});

test('removed migration command and real harness cannot be invoked from package scripts', () => {
  const scripts = [readFileSync(resolve(root, 'package.json'), 'utf8'),
    readFileSync(resolve(root, 'packages/projection-transport/package.json'), 'utf8')].join(' ');
  expect(scripts).not.toMatch(/test:projection-migration-real|test:real-migration|"migration"\s*:/);
});
