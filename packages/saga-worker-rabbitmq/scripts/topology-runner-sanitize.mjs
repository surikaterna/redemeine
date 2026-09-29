export function failureCategory(value) {
  const text = String(value ?? '');
  if (/requires the ['"]rabbit['"] app to be running|rabbit app.*not running/i.test(text)) return 'rabbit-app-not-running';
  if (/ACCESS_REFUSED|\b403\b/i.test(text)) return 'access-refused';
  if (/PRECONDITION_FAILED|\b406\b/i.test(text)) return 'precondition-failed';
  if (/permission denied|eacces/i.test(text)) return 'permission-denied';
  if (/timeout|timed out|deadline/i.test(text)) return 'timeout';
  if (/interrupted|sigterm|sigint/i.test(text)) return 'interrupted';
  if (/conflict|already exists/i.test(text)) return 'resource-collision';
  return 'redacted-operation-failure';
}

export function safeFailure(error, phase) {
  const message = error instanceof Error ? error.message : String(error);
  const operation = /^(docker|pnpm|git):[a-z-]+$/.test(error?.operation) ? error.operation : 'internal';
  return { phase, operation, exitCode: Number.isSafeInteger(error?.exitCode) ? error.exitCode : null,
    stderrCategory: failureCategory(error?.stderr), summary: failureCategory(message),
    ...(error?.cause ? { causeCategory: failureCategory(error.cause?.message ?? error.cause) } : {}) };
}

const TRUSTED_FIELDS = new Set([
  'issue', 'mode', 'runId', 'image', 'imageId', 'sha', 'sha256', 'scenarioSha', 'startedAt', 'finishedAt',
  'mongodbDriver', 'amqplib', 'dispatcher', 'tapeworm', 'rabbitmq', 'name', 'status', 'kind', 'action', 'id',
  'health', 'type', 'rawLogPath', 'phase', 'operation', 'summary', 'causeCategory', 'stderrCategory', 'cause',
  'errorClass', 'invariant', 'source', 'restartSubphase', 'amqpErrorClass'
]);
const SAFE_CATEGORIES = new Set(['connection-refused', 'node-unavailable', 'timeout', 'boot-failure',
  'error', 'warning', 'startup', 'other-redacted']);

function safeString(text, key) {
  if (key === 'categories') return SAFE_CATEGORIES.has(text) ? text : '[REDACTED]';
  if (['failure', 'failures', 'failureMessages', 'error', 'stderr', 'stdout'].includes(key) || key.endsWith('Error')) {
    return failureCategory(text);
  }
  if (!TRUSTED_FIELDS.has(key) || text.length > 256 || /password|secret|token|authorization|bearer|basic|:\/\/|[\r\n]/i.test(text)) {
    return '[REDACTED]';
  }
  return text;
}

export function sanitizeReceipt(value, key = '', depth = 0) {
  if (depth > 8) return '[REDACTED]';
  if (typeof value === 'string') return safeString(value, key);
  if (Array.isArray(value)) return value.map((entry) => sanitizeReceipt(entry, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) =>
    [name, sanitizeReceipt(entry, name, depth + 1)]));
  return value;
}
