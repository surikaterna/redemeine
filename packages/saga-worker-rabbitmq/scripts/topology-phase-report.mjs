const MARKER = 'REDEMEINE_TOPOLOGY_PHASE:';
const SOURCE = 'integration/topology-real.integration.test.ts';
const PHASES = new Set([
  'setup-topology', 'inspect-topology', 'publish-routed', 'publish-wrong-partition', 'publish-wrong-tenant',
  'publish-wrong-collection', 'broker-restart', 'restore-topology', 'held-unack', 'ack-settlement',
  'dead-letter', 'mismatch-setup', 'mismatch-reply-406', 'restricted-user-setup', 'restricted-reply-403'
]);
const INVARIANTS = new Set([
  'declared-and-bound', 'broker-inspected', 'routed-confirmed', 'mandatory-return', 'queue-ready-one',
  'same-volume-restarted', 'queue-retained-one', 'held-unack-one', 'queue-acked-zero', 'single-ack',
  'dead-letter-visible', 'declaration-conflict', 'reply-code-406', 'restricted-channel', 'reply-code-403'
]);
const CLASSES = new Set(['timeout', 'broker-reply', 'assertion', 'operation']);
const UNKNOWN = Object.freeze({ phase: 'unknown', invariant: 'unknown', errorClass: 'unknown', code: null,
  replyCode: null, expected: null, actual: null, source: SOURCE, line: 0 });

function safeNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function validated(value) {
  if (!value || typeof value !== 'object' || !PHASES.has(value.phase) || !INVARIANTS.has(value.invariant) ||
      !CLASSES.has(value.errorClass) || value.source !== SOURCE || !Number.isSafeInteger(value.line) || value.line <= 0) return UNKNOWN;
  return { phase: value.phase, invariant: value.invariant, errorClass: value.errorClass,
    code: safeNumber(value.code), replyCode: safeNumber(value.replyCode), expected: safeNumber(value.expected),
    actual: safeNumber(value.actual), source: SOURCE, line: value.line };
}

export function phaseFromJest(assertion) {
  const messages = [...(assertion.failureMessages ?? []), ...(assertion.failureDetails ?? []).map((detail) => detail?.message)];
  for (const message of messages) {
    if (typeof message !== 'string') continue;
    const token = message.match(/REDEMEINE_TOPOLOGY_PHASE:([A-Za-z0-9_-]+)/)?.[1];
    if (!token || token.length > 2048) continue;
    try { return validated(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))); }
    catch { return UNKNOWN; }
  }
  return UNKNOWN;
}

export { MARKER };
