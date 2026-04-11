const decodePathSegmentStrict = (segment: string): string => {
  if (/~(?![01])/u.test(segment)) {
    throw new Error(`Invalid RFC6902 JSON Pointer escape sequence in segment "${segment}".`);
  }

  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
};

export const parsePointer = (path: string): string[] => {
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

export const isArrayIndexLike = (token: string): boolean => token === '-' || /^\d+$/u.test(token);

export const isNumericArrayIndex = (token: string): boolean => /^\d+$/u.test(token);

export const parentTokens = (tokens: readonly string[]): string[] => {
  if (tokens.length <= 1) {
    return [];
  }

  return tokens.slice(0, -1);
};
