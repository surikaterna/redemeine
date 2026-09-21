export type JsonSafePrimitive = null | boolean | string | number;
export type JsonSafeValue = JsonSafePrimitive | JsonSafeValue[] | { [key: string]: JsonSafeValue };

// Leaves headroom below MongoDB's 16 MiB BSON document limit for event envelope metadata.
export const DEFAULT_BUSINESS_STATE_MAX_BYTES = 8 * 1024 * 1024;

export type BusinessStateValidationErrorCode = 'invalid_json_value' | 'cyclic_json_value' | 'business_state_too_large' | 'invalid_max_bytes';

export class BusinessStateValidationError extends Error {
  readonly code: BusinessStateValidationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: BusinessStateValidationErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'BusinessStateValidationError';
    this.code = code;
    this.details = details;
  }
}

export interface BusinessStateValidationOptions {
  readonly maxBytes?: number;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectInvalid(path: string, reason: string): never {
  throw new BusinessStateValidationError('invalid_json_value', `Business state is not JSON-safe at ${path}: ${reason}`, {
    path,
    reason
  });
}

function assertArray(value: unknown[], path: string, ancestors: WeakSet<object>): void {
  if (Object.keys(value).length !== value.length) {
    rejectInvalid(path, 'arrays must be dense and have no additional enumerable properties');
  }
  for (let index = 0; index < value.length; index += 1) {
    assertJsonValue(value[index], `${path}[${index}]`, ancestors);
  }
}

function assertObject(value: Record<string, unknown>, path: string, ancestors: WeakSet<object>): void {
  const enumerableKeys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== enumerableKeys.length) {
    rejectInvalid(path, 'objects must contain only enumerable string keys');
  }
  for (const key of enumerableKeys) {
    assertJsonValue(value[key], `${path}.${key}`, ancestors);
  }
}

function assertJsonValue(value: unknown, path: string, ancestors: WeakSet<object>): asserts value is JsonSafeValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) rejectInvalid(path, 'numbers must be finite');
    return;
  }
  if (typeof value !== 'object') {
    rejectInvalid(path, `unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new BusinessStateValidationError('cyclic_json_value', `Business state contains a cycle at ${path}`, { path });
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    rejectInvalid(path, 'objects must be arrays or plain objects');
  }

  ancestors.add(value);
  if (Array.isArray(value)) assertArray(value, path, ancestors);
  else assertObject(value, path, ancestors);
  ancestors.delete(value);
}

function resolveMaxBytes(options: BusinessStateValidationOptions): number {
  const maxBytes = options.maxBytes ?? DEFAULT_BUSINESS_STATE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new BusinessStateValidationError('invalid_max_bytes', 'Business state maxBytes must be a positive safe integer', {
      maxBytes
    });
  }
  return maxBytes;
}

export function validateBusinessState(value: unknown, options: BusinessStateValidationOptions = {}): asserts value is JsonSafeValue {
  assertJsonValue(value, '$', new WeakSet<object>());
  const maxBytes = resolveMaxBytes(options);
  const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (encodedBytes > maxBytes) {
    throw new BusinessStateValidationError('business_state_too_large', `Business state is ${encodedBytes} bytes; maximum is ${maxBytes}`, {
      encodedBytes,
      maxBytes
    });
  }
}

export function isJsonSafeBusinessState(value: unknown, options: BusinessStateValidationOptions = {}): value is JsonSafeValue {
  try {
    validateBusinessState(value, options);
    return true;
  } catch (error) {
    if (error instanceof BusinessStateValidationError) return false;
    throw error;
  }
}
