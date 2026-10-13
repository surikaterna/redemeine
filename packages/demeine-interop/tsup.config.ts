import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseConfig,
  // Preserve the declared Node emitter contract even when consumers disable ambient types.
  dts: { banner: '/// <reference types="node" />' },
  format: ['esm', 'cjs'],
  entry: ['src/index.ts'],
});
