export type JsonSafePrimitive = null | boolean | string | number;
export type JsonSafeValue = JsonSafePrimitive | JsonSafeValue[] | { [key: string]: JsonSafeValue };

// Leaves headroom below MongoDB's 16 MiB BSON document limit for event envelope metadata.
export const DEFAULT_BUSINESS_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_BUSINESS_STATE_MAX_DEPTH = 256;
export const DEFAULT_BUSINESS_STATE_MAX_NODES = 100_000;

export type BusinessStateValidationErrorCode =
  | 'invalid_json_value'
  | 'cyclic_json_value'
  | 'business_state_too_large'
  | 'business_state_too_deep'
  | 'business_state_too_complex'
  | 'property_inspection_failed'
  | 'invalid_validation_limit';

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
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

interface ValidationLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

interface InspectedEntry {
  readonly key: string;
  readonly value: unknown;
}

interface InspectedContainer {
  readonly kind: 'array' | 'object';
  readonly entries: readonly InspectedEntry[];
}

type TraversalItem =
  | { readonly kind: 'visit'; readonly value: unknown; readonly path: string; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object; readonly token: ']' | '}' }
  | { readonly kind: 'token'; readonly token: string };

function fail(code: BusinessStateValidationErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BusinessStateValidationError(code, message, details);
}

function resolveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_validation_limit', `${name} must be a positive safe integer`, { name, value });
  }
  return value;
}

function resolveLimits(options: BusinessStateValidationOptions): ValidationLimits {
  return {
    maxBytes: resolveLimit('maxBytes', options.maxBytes ?? DEFAULT_BUSINESS_STATE_MAX_BYTES),
    maxDepth: resolveLimit('maxDepth', options.maxDepth ?? DEFAULT_BUSINESS_STATE_MAX_DEPTH),
    maxNodes: resolveLimit('maxNodes', options.maxNodes ?? DEFAULT_BUSINESS_STATE_MAX_NODES)
  };
}

function inspectProperties(value: object, path: string): readonly [PropertyKey, PropertyDescriptor][] {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) fail('property_inspection_failed', `Property disappeared during inspection at ${path}`, { path });
      return [key, descriptor];
    });
  } catch (error) {
    if (error instanceof BusinessStateValidationError) throw error;
    fail('property_inspection_failed', `Unable to inspect business state properties at ${path}`, { path });
  }
}

function inspectPrototype(value: object, path: string): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    fail('property_inspection_failed', `Unable to inspect business state prototype at ${path}`, { path });
  }
}

function requireDataProperty(descriptor: PropertyDescriptor, path: string): unknown {
  if (!descriptor.enumerable || !('value' in descriptor)) {
    fail('invalid_json_value', `Business state properties must be enumerable data properties at ${path}`, { path });
  }
  return descriptor.value;
}

function inspectArray(value: object, path: string): InspectedContainer {
  const properties = inspectProperties(value, path);
  const lengthProperty = properties.find(([key]) => key === 'length');
  const length = lengthProperty?.[1].value;
  if (!Number.isSafeInteger(length) || typeof length !== 'number' || length < 0) {
    fail('invalid_json_value', `Array length is invalid at ${path}`, { path });
  }
  if (properties.length !== length + 1) {
    fail('invalid_json_value', `Arrays must be dense and contain no additional properties at ${path}`, { path });
  }
  const entries: InspectedEntry[] = [];
  for (const [key, descriptor] of properties) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      fail('invalid_json_value', `Array property ${String(key)} is not a canonical index at ${path}`, { path });
    }
    entries.push({ key, value: requireDataProperty(descriptor, `${path}[${key}]`) });
  }
  entries.sort((left, right) => Number(left.key) - Number(right.key));
  return { kind: 'array', entries };
}

function inspectObject(value: object, path: string): InspectedContainer {
  const prototype = inspectPrototype(value, path);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid_json_value', `Business state objects must be plain objects at ${path}`, { path });
  }
  const entries = inspectProperties(value, path).map(([key, descriptor]) => {
    if (typeof key !== 'string') fail('invalid_json_value', `Business state symbol keys are not supported at ${path}`, { path });
    return { key, value: requireDataProperty(descriptor, `${path}.${key}`) };
  });
  return { kind: 'object', entries };
}

function inspectContainer(value: object, path: string): InspectedContainer {
  try {
    return Array.isArray(value) ? inspectArray(value, path) : inspectObject(value, path);
  } catch (error) {
    if (error instanceof BusinessStateValidationError) throw error;
    fail('property_inspection_failed', `Unable to inspect business state container at ${path}`, { path });
  }
}

function encodeString(value: string, path: string): string {
  try {
    return JSON.stringify(value);
  } catch {
    fail('property_inspection_failed', `Unable to encode business state string at ${path}`, { path });
  }
}

function primitiveToken(value: unknown, path: string): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return encodeString(value, path);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_json_value', `Business state numbers must be finite at ${path}`, { path });
    return Object.is(value, -0) ? '0' : value.toString(10);
  }
  if (typeof value !== 'object') {
    fail('invalid_json_value', `Business state contains unsupported ${typeof value} at ${path}`, { path });
  }
  return undefined;
}

function pushContainer(stack: TraversalItem[], container: InspectedContainer, value: object, path: string, depth: number): void {
  stack.push({ kind: 'exit', value, token: container.kind === 'array' ? ']' : '}' });
  for (let index = container.entries.length - 1; index >= 0; index -= 1) {
    const entry = container.entries[index];
    if (!entry) continue;
    if (index < container.entries.length - 1) stack.push({ kind: 'token', token: ',' });
    stack.push({ kind: 'visit', value: entry.value, path: `${path}.${entry.key}`, depth: depth + 1 });
    if (container.kind === 'object') {
      stack.push({ kind: 'token', token: `${encodeString(entry.key, path)}:` });
    }
  }
}

function validateTraversal(value: unknown, limits: ValidationLimits): void {
  const stack: TraversalItem[] = [{ kind: 'visit', value, path: '$', depth: 0 }];
  const ancestors = new WeakSet<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  let encodedBytes = 0;
  const addToken = (token: string) => {
    encodedBytes += encoder.encode(token).byteLength;
    if (encodedBytes > limits.maxBytes) {
      fail('business_state_too_large', `Business state exceeds ${limits.maxBytes} encoded bytes`, { encodedBytes, maxBytes: limits.maxBytes });
    }
  };

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (item.kind === 'token') {
      addToken(item.token);
      continue;
    }
    if (item.kind === 'exit') {
      ancestors.delete(item.value);
      addToken(item.token);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes) fail('business_state_too_complex', `Business state exceeds ${limits.maxNodes} nodes`, { nodes });
    if (item.depth > limits.maxDepth) fail('business_state_too_deep', `Business state exceeds depth ${limits.maxDepth}`, { depth: item.depth });
    const token = primitiveToken(item.value, item.path);
    if (token !== undefined) {
      addToken(token);
      continue;
    }
    if (typeof item.value !== 'object' || item.value === null) {
      fail('invalid_json_value', `Business state contains an unsupported value at ${item.path}`, { path: item.path });
    }
    const containerValue = item.value;
    if (ancestors.has(containerValue)) fail('cyclic_json_value', `Business state contains a cycle at ${item.path}`, { path: item.path });
    const container = inspectContainer(containerValue, item.path);
    if (nodes + container.entries.length > limits.maxNodes) {
      fail('business_state_too_complex', `Business state exceeds ${limits.maxNodes} nodes`, { nodes: nodes + container.entries.length });
    }
    ancestors.add(containerValue);
    addToken(container.kind === 'array' ? '[' : '{');
    pushContainer(stack, container, containerValue, item.path, item.depth);
  }
}

export function validateBusinessState(value: unknown, options: BusinessStateValidationOptions = {}): asserts value is JsonSafeValue {
  validateTraversal(value, resolveLimits(options));
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
