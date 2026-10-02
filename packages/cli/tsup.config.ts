import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts', 'src/reflector.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  external: ['typescript', 'zod', '@redemeine/kernel'],
});
