export const toMongoPath = (tokens: readonly string[]): string | null => {
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

export const hasUnsafeToken = (tokens: readonly string[]): boolean => {
  return tokens.some((token) => token.includes('.') || token.startsWith('$'));
};
