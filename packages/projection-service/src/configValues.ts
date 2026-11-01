export type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(readonly variable: string, readonly reason: string) {
    super('invalid_configuration');
  }
}

export function integer(env: Environment, name: string, fallback: number, min: number, max: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(value)) throw new ConfigError(name, 'bounded_integer_required');
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new ConfigError(name, 'out_of_range');
  return parsed;
}

export function nameValue(env: Environment, name: string): string {
  const value = env[name];
  if (!value || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) throw new ConfigError(name, 'bounded_name_required');
  return value;
}

export function connectionUri(env: Environment, name: string, protocols: readonly string[]): URL {
  const value = env[name];
  if (!value || value.length > 4096) throw new ConfigError(name, 'uri_required');
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.hash) throw new Error('invalid');
    return parsed;
  } catch { throw new ConfigError(name, 'invalid_uri'); }
}
