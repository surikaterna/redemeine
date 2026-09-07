import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: [
      {
        find: /^@redemeine\/(.+)$/,
        replacement: `${root}packages/$1/src`,
      },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
