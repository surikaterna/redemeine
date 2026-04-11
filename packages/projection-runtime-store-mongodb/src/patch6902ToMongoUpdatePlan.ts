import type { ProjectionStoreRfc6902Operation } from './contracts';

type MongoScalarPath = string;

export type MongoPatchCompiledPlan = {
  mode: 'compiled';
  set: Readonly<Record<MongoScalarPath, unknown>>;
  unset: ReadonlyArray<MongoScalarPath>;
  testGuards: ReadonlyArray<{ path: MongoScalarPath; value: unknown }>;
};

export type MongoPatchFallbackPlan<TState> = {
  mode: 'fallback-full-document';
  fullDocument: TState;
};

export type MongoPatchUpdatePlan<TState> = MongoPatchCompiledPlan | MongoPatchFallbackPlan<TState>;

const decodePathSegmentStrict = (segment: string): string => {
  if (/~(?![01])/u.test(segment)) {
    throw new Error(`Invalid RFC6902 JSON Pointer escape sequence in segment "${segment}".`);
  }

  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
};

const parsePointer = (path: string): string[] => {
  if (path === '') {
    return [];
  }

  if (!path.startsWith('/')) {
    throw new Error(`Invalid RFC6902 JSON Pointer path "${path}".`);
  }

  const normalized = path.slice(1);
  if (!normalized) {
    return [];
  }

  return normalized.split('/').map(decodePathSegmentStrict);
};

const toMongoPath = (tokens: readonly string[]): string | null => {
  if (tokens.length === 0) {
    return null;
  }

  for (const token of tokens) {
    if (token.includes('.') || token.startsWith('$')) {
      return null;
    }
  }

  return tokens.join('.');
};

const readAtPointer = (root: unknown, pointer: string): { found: boolean; value: unknown } => {
  const tokens = parsePointer(pointer);
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

const parentPointer = (path: string): string => {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    return '';
  }

  if (tokens.length === 1) {
    return '';
  }

  return `/${tokens.slice(0, -1).join('/')}`;
};

const isArrayIndexLike = (token: string): boolean => token === '-' || /^\d+$/u.test(token);

export const patch6902ToMongoUpdatePlan = <TState>(
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>,
  fullDocument: TState
): MongoPatchUpdatePlan<TState> => {
  const set: Record<string, unknown> = {};
  const unset = new Set<string>();
  const testGuards: Array<{ path: string; value: unknown }> = [];

  const setAtPathFromFullDocument = (path: string): boolean => {
    const pointerTokens = parsePointer(path);
    const mongoPath = toMongoPath(pointerTokens);
    if (mongoPath === null) {
      return false;
    }

    const read = readAtPointer(fullDocument, path);
    if (!read.found) {
      return false;
    }

    set[mongoPath] = read.value;
    unset.delete(mongoPath);
    return true;
  };

  const removeAtPath = (path: string): boolean => {
    const tokens = parsePointer(path);
    if (tokens.length === 0) {
      return false;
    }

    const leaf = tokens[tokens.length - 1] ?? '';
    if (isArrayIndexLike(leaf)) {
      const parent = parentPointer(path);
      return setAtPathFromFullDocument(parent);
    }

    const mongoPath = toMongoPath(tokens);
    if (mongoPath === null) {
      return false;
    }

    unset.add(mongoPath);
    delete set[mongoPath];
    return true;
  };

  for (const operation of patch) {
    if (operation.op === 'test') {
      const tokens = parsePointer(operation.path);
      const mongoPath = toMongoPath(tokens);
      if (mongoPath === null) {
        return { mode: 'fallback-full-document', fullDocument };
      }

      testGuards.push({ path: mongoPath, value: operation.value });
      continue;
    }

    if (operation.op === 'remove') {
      if (!removeAtPath(operation.path)) {
        return { mode: 'fallback-full-document', fullDocument };
      }
      continue;
    }

    if (operation.op === 'replace' || operation.op === 'add') {
      const tokens = parsePointer(operation.path);
      if (tokens.length === 0) {
        return { mode: 'fallback-full-document', fullDocument };
      }

      const leaf = tokens[tokens.length - 1] ?? '';
      if (isArrayIndexLike(leaf)) {
        const parent = parentPointer(operation.path);
        if (!setAtPathFromFullDocument(parent)) {
          return { mode: 'fallback-full-document', fullDocument };
        }
      } else if (!setAtPathFromFullDocument(operation.path)) {
        return { mode: 'fallback-full-document', fullDocument };
      }
      continue;
    }

    if (operation.op === 'copy') {
      if (!operation.from) {
        throw new Error('RFC6902 copy operation requires "from".');
      }

      if (!setAtPathFromFullDocument(operation.path)) {
        return { mode: 'fallback-full-document', fullDocument };
      }
      continue;
    }

    if (operation.op === 'move') {
      if (!operation.from) {
        throw new Error('RFC6902 move operation requires "from".');
      }

      if (!removeAtPath(operation.from) || !setAtPathFromFullDocument(operation.path)) {
        return { mode: 'fallback-full-document', fullDocument };
      }
      continue;
    }

    return { mode: 'fallback-full-document', fullDocument };
  }

  return {
    mode: 'compiled',
    set,
    unset: [...unset.values()],
    testGuards
  };
};
