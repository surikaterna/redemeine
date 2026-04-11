const rootStateRef = '$state';

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

const buildFieldRef = (safeTokens: readonly string[]): string => {
  return safeTokens.length === 0 ? rootStateRef : `${rootStateRef}.${safeTokens.join('.')}`;
};

const getFieldExpr = (inputExpr: unknown, field: string): Record<string, unknown> => ({
  $getField: {
    input: inputExpr,
    field
  }
});

export const buildPresenceGuardExpr = (safeTokens: readonly string[]): Record<string, unknown> => ({
  $ne: [{ $type: buildFieldRef(safeTokens) }, 'missing']
});

export const buildTypeGuardExpr = (
  safeTokens: readonly string[],
  expected: 'array' | 'object'
): Record<string, unknown> => ({
  $eq: [{ $type: buildFieldRef(safeTokens) }, expected]
});

export const buildStrictEqualityExpr = (safeTokens: readonly string[], value: unknown): Record<string, unknown> => {
  const fieldRef = buildFieldRef(safeTokens);
  const expectedType = mongoTypeForValue(value);

  return {
    $and: [{ $eq: [{ $type: fieldRef }, expectedType] }, { $eq: [fieldRef, value] }]
  };
};

export const buildUnsafeReadExpr = (tokens: readonly string[]): unknown => {
  let current: unknown = rootStateRef;

  for (const token of tokens) {
    current = getFieldExpr(current, token);
  }

  return current;
};

export const setUnsafeAtTokensExpr = (targetExpr: unknown, tokens: readonly string[], valueExpr: unknown): unknown => {
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

export const unsetUnsafeAtTokensExpr = (targetExpr: unknown, tokens: readonly string[]): unknown => {
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
