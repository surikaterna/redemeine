import { CommandContext } from '../types';

export function createCommandContextProxy<TIntents extends Record<string, unknown>>(): CommandContext<TIntents> {
  return new Proxy({}, {
    get: (_target, prop: string) => {
      return (payload: unknown) => ({
        command: prop,
        payload
      });
    }
  }) as CommandContext<TIntents>;
}
