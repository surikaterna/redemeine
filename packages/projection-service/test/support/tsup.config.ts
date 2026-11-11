import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['test/support/processHost.ts', 'test/support/signalBoundaryHost.ts', 'test/support/harnessAbortProcess.ts'],
  outDir: 'test/.built', format: ['esm'], platform: 'node', target: 'node22',
  clean: true, splitting: false, noExternal: [/@redemeine\//, 'mongodb', 'amqplib'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
});
