import { defineConfig, type Options } from 'tsup'

export const baseConfig: Options = {
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
}
