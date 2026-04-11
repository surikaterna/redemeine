import { parsePointer } from './pointer';

export const readAtTokens = (root: unknown, tokens: readonly string[]): { found: boolean; value: unknown } => {
  let current: unknown = root;

  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(token)) {
        return { found: false, value: undefined };
      }

      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }

      current = current[index];
      continue;
    }

    if (!current || typeof current !== 'object') {
      return { found: false, value: undefined };
    }

    if (!(token in current)) {
      return { found: false, value: undefined };
    }

    current = (current as Record<string, unknown>)[token];
  }

  return { found: true, value: current };
};

export const readAtPointer = (root: unknown, pointer: string): { found: boolean; value: unknown } => {
  return readAtTokens(root, parsePointer(pointer));
};
