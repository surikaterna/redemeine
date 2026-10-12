import { defineConfig } from 'tsup';

export default defineConfig({ entry: ['integration/externalStack.ts'], outDir: 'integration/.built', format: ['esm'],
  platform: 'node', target: 'node22', clean: true, splitting: false,
  noExternal: [/@redemeine\//, 'mongodb', 'amqplib'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
});
