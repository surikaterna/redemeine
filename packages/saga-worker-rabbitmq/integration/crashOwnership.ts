export interface OwnedNames { readonly vhost: string; readonly user: string; readonly db: string }
export interface OwnedOps {
  absent(kind: 'vhost' | 'user' | 'db', name: string): Promise<boolean>;
  createVhost(name: string): Promise<void>;
  createUser(name: string): Promise<void>;
  grant(vhost: string, user: string): Promise<void>;
  removeVhost(name: string): Promise<'removed' | 'absent'>;
  removeUser(name: string): Promise<'removed' | 'absent'>;
  removeDb(name: string): Promise<'removed' | 'absent'>;
}

export class OwnerMismatchError extends Error {
  constructor() { super('owned resource marker mismatch'); this.name = 'OwnerMismatchError'; }
}
export class DeadlineExceededError extends Error {
  constructor() { super('bounded operation timed out'); this.name = 'DeadlineExceededError'; }
}

export interface CleanupOutcome {
  readonly status: 'removed' | 'absent' | 'not_attempted' | 'timeout' | 'owner_mismatch' | 'failed';
  readonly reason: 'none' | 'timeout' | 'owner_mismatch' | 'failed';
}
export interface OwnedCleanup { readonly vhost: CleanupOutcome; readonly user: CleanupOutcome; readonly db: CleanupOutcome }

function cleanupOutcome(result: PromiseSettledResult<'removed' | 'absent'>, attempted: boolean): CleanupOutcome {
  if (!attempted) return { status: 'not_attempted', reason: 'none' };
  if (result.status === 'fulfilled') return { status: result.value, reason: 'none' };
  const status = result.reason instanceof OwnerMismatchError ? 'owner_mismatch' :
    result.reason instanceof DeadlineExceededError || result.reason instanceof Error &&
      (result.reason.name === 'TimeoutError' || result.reason.name === 'AbortError') ? 'timeout' : 'failed';
  return { status, reason: status };
}

export function cleanupSucceeded(cleanup: OwnedCleanup): boolean {
  return Object.values(cleanup).every(outcome => outcome.status === 'removed' || outcome.status === 'absent');
}

export async function deadline<T>(label: string, operation: () => Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceededError()), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class OwnedCrashScope {
  private armed = false;
  private vhostAttempted = false;
  private userAttempted = false;
  private dbAttempted = false;
  constructor(readonly names: OwnedNames, private readonly ops: OwnedOps, private readonly cleanupMs = 5_000) {}

  async preflight(): Promise<void> {
    // No name is eligible for deletion until every namespace was observed absent.
    for (const [kind, name] of [
      ['vhost', this.names.vhost], ['user', this.names.user], ['db', this.names.db]
    ] as const) {
      if (!await deadline(`preflight ${kind}`, () => this.ops.absent(kind, name))) {
        throw new Error('owned crash name collision');
      }
    }
    this.armed = true;
  }

  async setup(): Promise<void> {
    if (!this.armed) throw new Error('owned crash scope was not preflighted');
    this.vhostAttempted = true;
    await deadline('create vhost', () => this.ops.createVhost(this.names.vhost));
    this.userAttempted = true;
    await deadline('create user', () => this.ops.createUser(this.names.user));
    await deadline('grant permission', () => this.ops.grant(this.names.vhost, this.names.user));
  }

  markDbAttempted(): void {
    if (!this.armed) throw new Error('owned crash scope was not preflighted');
    this.dbAttempted = true;
  }

  async cleanup(): Promise<OwnedCleanup> {
    const attempts = await Promise.allSettled([
      this.vhostAttempted ? deadline('remove vhost', () => this.ops.removeVhost(this.names.vhost), this.cleanupMs) : Promise.resolve<'absent'>('absent'),
      this.userAttempted ? deadline('remove user', () => this.ops.removeUser(this.names.user), this.cleanupMs) : Promise.resolve<'absent'>('absent'),
      this.dbAttempted ? deadline('remove database', () => this.ops.removeDb(this.names.db), this.cleanupMs) : Promise.resolve<'absent'>('absent')
    ]);
    return { vhost: cleanupOutcome(attempts[0]!, this.vhostAttempted),
      user: cleanupOutcome(attempts[1]!, this.userAttempted),
      db: cleanupOutcome(attempts[2]!, this.dbAttempted) };
  }
}
