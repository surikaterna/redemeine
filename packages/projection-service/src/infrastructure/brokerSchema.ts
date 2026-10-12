import { isDeepStrictEqual } from 'node:util';

export class BrokerRefusal extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function object(value: unknown, reason = 'broker_schema_invalid'): Record<string, unknown> {
  if (!isObject(value)) throw new BrokerRefusal(reason);
  return value;
}

export function string(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new BrokerRefusal('broker_schema_invalid');
  return value;
}

export function list(value: unknown, max = 64, reason = 'broker_schema_invalid'): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new BrokerRefusal(reason);
  return value;
}

export function same(actual: unknown, expected: unknown, reason = 'broker_identity_mismatch'): void {
  if (!isDeepStrictEqual(actual, expected)) throw new BrokerRefusal(reason);
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BrokerRefusal('broker_schema_invalid');
  return value;
}
