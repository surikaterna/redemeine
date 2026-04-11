import type { MongoPatchFallbackPlan } from './types';

export const fallback = <TState>(
  fullDocument: TState,
  fallbackReason: string,
  cacheKey: string
): MongoPatchFallbackPlan<TState> => ({
  mode: 'fallback-full-document',
  fullDocument,
  fallbackReason,
  cacheKey
});
