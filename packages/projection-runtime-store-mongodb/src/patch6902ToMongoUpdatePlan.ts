import type { ProjectionStoreRfc6902Operation } from './contracts';

type MongoScalarPath = string;

export type MongoPatchTestGuard = { path: MongoScalarPath; value: unknown };

type MongoPatchBaseCompiledPlan = {
  testGuards: ReadonlyArray<MongoPatchTestGuard>;
  exprGuards: ReadonlyArray<Record<string, unknown>>;
  cacheKey: string;
};

export type MongoPatchCompiledUpdateDocumentPlan = MongoPatchBaseCompiledPlan & {
  mode: 'compiled-update-document';
  set: Readonly<Record<MongoScalarPath, unknown>>;
  unset: ReadonlyArray<MongoScalarPath>;
  push: Readonly<Record<MongoScalarPath, unknown>>;
  pop: Readonly<Record<MongoScalarPath, 1 | -1>>;
};

export type MongoPatchCompiledUpdatePipelinePlan = MongoPatchBaseCompiledPlan & {
  mode: 'compiled-update-pipeline';
  pipeline: ReadonlyArray<Record<string, unknown>>;
};

export type MongoPatchFallbackPlan<TState> = {
  mode: 'fallback-full-document';
  fullDocument: TState;
  fallbackReason: string;
  cacheKey: string;
};

export type MongoPatchCompiledPlan = MongoPatchCompiledUpdateDocumentPlan | MongoPatchCompiledUpdatePipelinePlan;

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

const hasUnsafeToken = (tokens: readonly string[]): boolean =>
  tokens.some((token) => token.includes('.') || token.startsWith('$'));

const readAtTokens = (root: unknown, tokens: readonly string[]): { found: boolean; value: unknown } => {
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

const readAtPointer = (root: unknown, pointer: string): { found: boolean; value: unknown } => readAtTokens(root, parsePointer(pointer));

const parentTokens = (tokens: readonly string[]): string[] => {
  if (tokens.length <= 1) {
    return [];
  }
  return tokens.slice(0, -1);
};

const isArrayIndexLike = (token: string): boolean => token === '-' || /^\d+$/u.test(token);
const isNumericArrayIndex = (token: string): boolean => /^\d+$/u.test(token);

const makeCacheKey = (patch: ReadonlyArray<ProjectionStoreRfc6902Operation>): string => {
  const shape = patch.map((op) => {
    const valueType = op.op === 'test' || op.op === 'add' || op.op === 'replace' ? typeTag((op as { value?: unknown }).value) : '-';
    return `${op.op}|${op.path}|${'from' in op && op.from ? op.from : '-'}|${valueType}`;
  });
  return shape.join('::');
};

const typeTag = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
};

const mongoTypeForValue = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  if (typeof value === 'number') {
    return 'double';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  return 'string';
};

const rootStateRef = '$state';

const buildFieldRef = (safeTokens: readonly string[]): string =>
  safeTokens.length === 0 ? rootStateRef : `${rootStateRef}.${safeTokens.join('.')}`;

const buildPresenceGuardExpr = (safeTokens: readonly string[]): Record<string, unknown> => ({
  $ne: [{ $type: buildFieldRef(safeTokens) }, 'missing']
});

const buildTypeGuardExpr = (safeTokens: readonly string[], expected: 'array' | 'object'): Record<string, unknown> => ({
  $eq: [{ $type: buildFieldRef(safeTokens) }, expected]
});

const buildStrictEqualityExpr = (safeTokens: readonly string[], value: unknown): Record<string, unknown> => {
  const fieldRef = buildFieldRef(safeTokens);
  const expectedType = mongoTypeForValue(value);
  return {
    $and: [{ $eq: [{ $type: fieldRef }, expectedType] }, { $eq: [fieldRef, value] }]
  };
};

const buildMiddleArrayRemovePipeline = (mongoArrayPath: string, removeAtIndex: number): ReadonlyArray<Record<string, unknown>> => {
  const fieldRef = `$state.${mongoArrayPath}`;
  return [
    {
      $set: {
        [`state.${mongoArrayPath}`]: {
          $concatArrays: [
            {
              $slice: [fieldRef, removeAtIndex]
            },
            {
              $slice: [
                fieldRef,
                removeAtIndex + 1,
                {
                  $subtract: [{ $size: fieldRef }, removeAtIndex + 1]
                }
              ]
            }
          ]
        }
      }
    }
  ];
};

const buildMiddleArrayInsertPipeline = (
  mongoArrayPath: string,
  insertAtIndex: number,
  insertedValue: unknown
): ReadonlyArray<Record<string, unknown>> => {
  const fieldRef = `$state.${mongoArrayPath}`;
  return [
    {
      $set: {
        [`state.${mongoArrayPath}`]: {
          $concatArrays: [
            {
              $slice: [fieldRef, insertAtIndex]
            },
            [insertedValue],
            {
              $slice: [
                fieldRef,
                insertAtIndex,
                {
                  $subtract: [{ $size: fieldRef }, insertAtIndex]
                }
              ]
            }
          ]
        }
      }
    }
  ];
};

const getFieldExpr = (inputExpr: unknown, field: string): Record<string, unknown> => ({
  $getField: {
    input: inputExpr,
    field
  }
});

const buildUnsafeReadExpr = (tokens: readonly string[]): unknown => {
  let current: unknown = rootStateRef;
  for (const token of tokens) {
    current = getFieldExpr(current, token);
  }
  return current;
};

const setUnsafeAtTokensExpr = (targetExpr: unknown, tokens: readonly string[], valueExpr: unknown): unknown => {
  if (tokens.length === 0) {
    return valueExpr;
  }

  const [head, ...tail] = tokens;
  const existingChildExpr = getFieldExpr(targetExpr, head);
  const nextChild = setUnsafeAtTokensExpr(existingChildExpr, tail, valueExpr);

  return {
    $setField: {
      input: targetExpr,
      field: head,
      value: nextChild
    }
  };
};

const unsetUnsafeAtTokensExpr = (targetExpr: unknown, tokens: readonly string[]): unknown => {
  if (tokens.length === 0) {
    return targetExpr;
  }

  if (tokens.length === 1) {
    return {
      $unsetField: {
        input: targetExpr,
        field: tokens[0]
      }
    };
  }

  const [head, ...tail] = tokens;
  const existingChildExpr = getFieldExpr(targetExpr, head);
  const nextChild = unsetUnsafeAtTokensExpr(existingChildExpr, tail);

  return {
    $setField: {
      input: targetExpr,
      field: head,
      value: nextChild
    }
  };
};

const fallback = <TState>(fullDocument: TState, fallbackReason: string, cacheKey: string): MongoPatchFallbackPlan<TState> => ({
  mode: 'fallback-full-document',
  fullDocument,
  fallbackReason,
  cacheKey
});

export const patch6902ToMongoUpdatePlan = <TState>(
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>,
  fullDocument: TState
): MongoPatchUpdatePlan<TState> => patch6902ToMongoUpdatePlanWithMetadata(patch, fullDocument);

export const patch6902ToMongoUpdatePlanWithMetadata = <TState>(
  patch: ReadonlyArray<ProjectionStoreRfc6902Operation>,
  fullDocument: TState
): MongoPatchUpdatePlan<TState> => {
  const cacheKey = makeCacheKey(patch);
  const set: Record<string, unknown> = {};
  const unset = new Set<string>();
  const push: Record<string, unknown> = {};
  const pop: Record<string, 1 | -1> = {};
  const testGuards: Array<MongoPatchTestGuard> = [];
  const exprGuards: Array<Record<string, unknown>> = [];
  let pipeline: ReadonlyArray<Record<string, unknown>> | null = null;

  const hasPushOrPop = (): boolean => Object.keys(push).length > 0 || Object.keys(pop).length > 0;

  const setAtPathFromFullDocument = (path: string): boolean => {
    const tokens = parsePointer(path);
    if (tokens.length === 0) {
      return false;
    }

    const mongoPath = toMongoPath(tokens);
    if (mongoPath === null) {
      return false;
    }

    const read = readAtTokens(fullDocument, tokens);
    if (!read.found) {
      return false;
    }

    set[mongoPath] = read.value;
    unset.delete(mongoPath);
    return true;
  };

  const compileArrayAdd = (tokens: readonly string[], opPath: string): boolean => {
    const leaf = tokens[tokens.length - 1] ?? '';
    const parent = parentTokens(tokens);
    const mongoParentPath = toMongoPath(parent);
    if (mongoParentPath === null) {
      return false;
    }

    const parentState = readAtPointer(fullDocument, parent.length === 0 ? '' : `/${parent.join('/')}`);
    if (!parentState.found || !Array.isArray(parentState.value)) {
      return false;
    }

    exprGuards.push(buildTypeGuardExpr(parent, 'array'));

    if (leaf === '-') {
      if (parentState.value.length === 0) {
        return false;
      }

      push[mongoParentPath] = parentState.value[parentState.value.length - 1];
      return true;
    }

    if (!isNumericArrayIndex(leaf)) {
      return false;
    }

    const addIndex = Number(leaf);
    if (addIndex < 0 || !Number.isInteger(addIndex)) {
      return false;
    }

    const resultArray = parentState.value;
    const preLength = resultArray.length - 1;

    if (addIndex === preLength) {
      push[mongoParentPath] = resultArray[addIndex];
      return true;
    }

    if (addIndex >= 0 && addIndex < preLength) {
      if (pipeline !== null || hasPushOrPop()) {
        return false;
      }

      const insertedValue = readAtPointer(fullDocument, opPath);
      if (!insertedValue.found) {
        return false;
      }

      pipeline = buildMiddleArrayInsertPipeline(mongoParentPath, addIndex, insertedValue.value);
      return true;
    }

    return false;
  };

  const removeAtPath = (path: string): boolean => {
    const tokens = parsePointer(path);
    if (tokens.length === 0) {
      return false;
    }

    const leaf = tokens[tokens.length - 1] ?? '';
    if (isArrayIndexLike(leaf)) {
      if (!isNumericArrayIndex(leaf)) {
        return false;
      }

      const parent = parentTokens(tokens);
      const mongoParentPath = toMongoPath(parent);
      if (mongoParentPath === null) {
        return false;
      }

      const removeAtIndex = Number(leaf);
      if (!Number.isInteger(removeAtIndex) || removeAtIndex < 0) {
        return false;
      }

      const parentState = readAtPointer(fullDocument, parent.length === 0 ? '' : `/${parent.join('/')}`);
      if (!parentState.found || !Array.isArray(parentState.value)) {
        return false;
      }

      exprGuards.push(buildTypeGuardExpr(parent, 'array'));

      const resultingLength = parentState.value.length;
      if (removeAtIndex === 0) {
        pop[mongoParentPath] = -1;
        delete set[mongoParentPath];
        unset.delete(mongoParentPath);
        return true;
      }

      if (removeAtIndex === resultingLength) {
        pop[mongoParentPath] = 1;
        delete set[mongoParentPath];
        unset.delete(mongoParentPath);
        return true;
      }

      if (removeAtIndex > 0 && removeAtIndex < resultingLength) {
        if (pipeline !== null || hasPushOrPop()) {
          return false;
        }

        pipeline = buildMiddleArrayRemovePipeline(mongoParentPath, removeAtIndex);
        return true;
      }

      return false;
    }

    const mongoPath = toMongoPath(tokens);
    if (mongoPath === null) {
      return false;
    }

    const parent = parentTokens(tokens);
    if (parent.length > 0) {
      exprGuards.push(buildTypeGuardExpr(parent, 'object'));
    }
    exprGuards.push(buildPresenceGuardExpr(tokens));

    unset.add(mongoPath);
    delete set[mongoPath];
    return true;
  };

  if (patch.length === 2 && patch[0]?.op === 'remove' && patch[1]?.op === 'add') {
    const removeTokens = parsePointer(patch[0].path);
    const addTokens = parsePointer(patch[1].path);
    if (
      removeTokens.length > 1 &&
      addTokens.length > 1 &&
      isNumericArrayIndex(removeTokens[removeTokens.length - 1] ?? '') &&
      isNumericArrayIndex(addTokens[addTokens.length - 1] ?? '')
    ) {
      const removeParent = parentTokens(removeTokens);
      const addParent = parentTokens(addTokens);
      if (removeParent.join('/') === addParent.join('/')) {
        const parentMongoPath = toMongoPath(removeParent);
        if (parentMongoPath !== null) {
          const parentRead = readAtTokens(fullDocument, removeParent);
          if (parentRead.found && Array.isArray(parentRead.value)) {
            set[parentMongoPath] = parentRead.value;
            return {
              mode: 'compiled-update-document',
              set,
              unset: [...unset.values()],
              push,
              pop,
              testGuards,
              exprGuards,
              cacheKey
            };
          }
        }
      }
    }
  }

  const allArrayOps = patch.every((op) => op.op === 'add' || op.op === 'remove');
  if (allArrayOps && patch.length > 1) {
    const opTokens = patch.map((op) => parsePointer(op.path));
    const allIndexed = opTokens.every(
      (tokens) => tokens.length > 1 && isArrayIndexLike(tokens[tokens.length - 1] ?? '')
    );

    if (allIndexed) {
      const parents = opTokens.map((tokens) => parentTokens(tokens).join('/'));
      const parent = parents[0];
      if (parent && parents.every((p) => p === parent)) {
        const parentTokensParsed = parent.split('/');
        const mongoPath = toMongoPath(parentTokensParsed);
        const arrayRead = readAtTokens(fullDocument, parentTokensParsed);
        if (mongoPath && arrayRead.found && Array.isArray(arrayRead.value)) {
          set[mongoPath] = arrayRead.value;
          exprGuards.push(buildTypeGuardExpr(parentTokensParsed, 'array'));
          return {
            mode: 'compiled-update-document',
            set,
            unset: [...unset.values()],
            push,
            pop,
            testGuards,
            exprGuards,
            cacheKey
          };
        }
      }
    }
  }

  const unsafeOps = patch
    .map((op) => ({
      op,
      tokens: parsePointer(op.path),
      fromTokens: 'from' in op && op.from ? parsePointer(op.from) : null
    }))
    .filter((entry) => hasUnsafeToken(entry.tokens) || (entry.fromTokens ? hasUnsafeToken(entry.fromTokens) : false));

  if (unsafeOps.length > 0) {
    const unsupportedUnsafe = unsafeOps.some(
      ({ op, tokens }) =>
        tokens.some((token) => isArrayIndexLike(token)) ||
        !['add', 'replace', 'remove', 'test'].includes(op.op)
    );
    if (unsupportedUnsafe) {
      return fallback(fullDocument, 'unsafe-path-unsupported-op', cacheKey);
    }

    if (patch.length !== unsafeOps.length) {
      return fallback(fullDocument, 'unsafe-path-mixed-with-safe-paths', cacheKey);
    }

    let stateExpr: unknown = rootStateRef;

    for (const { op, tokens } of unsafeOps) {
      if (op.op === 'test') {
        exprGuards.push({
          $eq: [buildUnsafeReadExpr(tokens), op.value]
        });
        continue;
      }

      if (op.op === 'remove') {
        if (tokens.length === 0) {
          stateExpr = fullDocument;
          continue;
        }

        stateExpr = unsetUnsafeAtTokensExpr(stateExpr, tokens);
        continue;
      }

      if (op.op === 'add' || op.op === 'replace') {
        if (tokens.length === 0) {
          stateExpr = fullDocument;
          continue;
        }

        const valueRead = readAtTokens(fullDocument, tokens);
        if (!valueRead.found) {
          return fallback(fullDocument, 'unsafe-path-target-not-found-in-full-document', cacheKey);
        }
        stateExpr = setUnsafeAtTokensExpr(stateExpr, tokens, valueRead.value);
        continue;
      }

      return fallback(fullDocument, 'unsafe-path-operation-not-compiled', cacheKey);
    }

    return {
      mode: 'compiled-update-pipeline',
      pipeline: [
        {
          $set: {
            state: stateExpr
          }
        }
      ],
      testGuards,
      exprGuards,
      cacheKey
    };
  }

  for (const operation of patch) {
    const tokens = parsePointer(operation.path);

    if (pipeline !== null && operation.op !== 'test') {
      return fallback(fullDocument, 'pipeline-mixed-with-follow-up-mutations', cacheKey);
    }

    if (operation.op === 'test') {
      if (tokens.length === 0) {
        exprGuards.push(buildStrictEqualityExpr([], operation.value));
      } else {
        const mongoPath = toMongoPath(tokens);
        if (mongoPath === null) {
          return fallback(fullDocument, 'unsafe-test-path', cacheKey);
        }

        testGuards.push({ path: mongoPath, value: operation.value });
        exprGuards.push(buildStrictEqualityExpr(tokens, operation.value));
      }
      continue;
    }

    if (operation.op === 'remove') {
      if (!removeAtPath(operation.path)) {
        return fallback(fullDocument, 'remove-not-compileable', cacheKey);
      }
      continue;
    }

    if (operation.op === 'replace' || operation.op === 'add') {
      if (tokens.length === 0) {
        return fallback(fullDocument, `${operation.op}-root-path-not-compiled`, cacheKey);
      }

      const leaf = tokens[tokens.length - 1] ?? '';
      if (isArrayIndexLike(leaf)) {
        if (operation.op === 'replace') {
          if (!isNumericArrayIndex(leaf)) {
            return fallback(fullDocument, 'replace-array-index-invalid', cacheKey);
          }
          if (!setAtPathFromFullDocument(operation.path)) {
            return fallback(fullDocument, 'replace-array-index-missing', cacheKey);
          }
          const parent = parentTokens(tokens);
          exprGuards.push(buildTypeGuardExpr(parent, 'array'));
          continue;
        }

        if (!compileArrayAdd(tokens, operation.path)) {
          return fallback(fullDocument, 'add-array-index-not-compileable', cacheKey);
        }
        continue;
      }

      const parent = parentTokens(tokens);
      if (parent.length > 0) {
        exprGuards.push(buildTypeGuardExpr(parent, 'object'));
      }

      if (operation.op === 'replace') {
        exprGuards.push(buildPresenceGuardExpr(tokens));
      }

      if (!setAtPathFromFullDocument(operation.path)) {
        return fallback(fullDocument, 'set-target-not-found-in-full-document', cacheKey);
      }
      continue;
    }

    if (operation.op === 'copy') {
      if (!operation.from) {
        throw new Error('RFC6902 copy operation requires "from".');
      }

      const fromTokens = parsePointer(operation.from);
      if (fromTokens.length > 0) {
        exprGuards.push(buildPresenceGuardExpr(fromTokens));
      }

      if (!setAtPathFromFullDocument(operation.path)) {
        return fallback(fullDocument, 'copy-target-not-found', cacheKey);
      }
      continue;
    }

    if (operation.op === 'move') {
      if (!operation.from) {
        throw new Error('RFC6902 move operation requires "from".');
      }

      const fromTokens = parsePointer(operation.from);
      const toTokens = tokens;

      if (
        fromTokens.length > 1 &&
        toTokens.length > 1 &&
        isNumericArrayIndex(fromTokens[fromTokens.length - 1] ?? '') &&
        isNumericArrayIndex(toTokens[toTokens.length - 1] ?? '')
      ) {
        const fromParent = parentTokens(fromTokens);
        const toParent = parentTokens(toTokens);
        if (fromParent.join('/') === toParent.join('/')) {
          const mongoPath = toMongoPath(fromParent);
          const parentRead = readAtTokens(fullDocument, fromParent);
          if (mongoPath && parentRead.found && Array.isArray(parentRead.value)) {
            set[mongoPath] = parentRead.value;
            continue;
          }
        }
      }

      if (!removeAtPath(operation.from) || !setAtPathFromFullDocument(operation.path)) {
        return fallback(fullDocument, 'move-not-compileable', cacheKey);
      }
      continue;
    }

    return fallback(fullDocument, 'unsupported-operation', cacheKey);
  }

  if (pipeline !== null) {
    const stage = pipeline[0];
    if (!stage || typeof stage !== 'object' || !('$set' in stage)) {
      return fallback(fullDocument, 'pipeline-stage-invalid', cacheKey);
    }

    const stageSet = (stage.$set as Record<string, unknown> | undefined) ?? {};
    return {
      mode: 'compiled-update-pipeline',
      pipeline: [
        {
          $set: {
            ...stageSet
          }
        }
      ],
      testGuards,
      exprGuards,
      cacheKey
    };
  }

  return {
    mode: 'compiled-update-document',
    set,
    unset: [...unset.values()],
    push,
    pop,
    testGuards,
    exprGuards,
    cacheKey
  };
};
