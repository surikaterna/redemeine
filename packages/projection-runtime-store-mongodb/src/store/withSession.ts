import type { ClientSession } from 'mongodb';

export const withSession = <T extends object>(options: T, session: ClientSession): T & { session: ClientSession } => ({
  ...options,
  session
});
