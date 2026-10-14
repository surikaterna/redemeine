import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.config.base'

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  noExternal: [
    '@redemeine/projection-runtime-core',
    '@redemeine/projection-runtime-store-inmemory',
  ],
  external: [
    /^@redemeine\/(kernel|aggregate|mirage|projection|saga)(\/|$)/,
    /^immer(\/|$)/,
  ],
})
