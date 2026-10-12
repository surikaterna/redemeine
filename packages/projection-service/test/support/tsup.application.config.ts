import { defineConfig } from 'tsup';

export default defineConfig({ entry: { definitions: 'examples/definitions.ts' }, outDir: 'test/.built/application',
  format: ['esm'], platform: 'node', target: 'node22', clean: true, dts: true, outExtension: () => ({ js: '.mjs' }) });
