import { defineConfig } from 'tsup';

export default defineConfig({ entry: { main: 'src/workerMain.ts' }, outDir: 'dist-worker', format: ['esm'], platform: 'node', target: 'node22',
  clean: true, splitting: false, sourcemap: false, metafile: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  noExternal: [/@redemeine\//, 'mongodb', 'amqplib'] });
