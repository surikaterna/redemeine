import { Timestamp } from 'mongodb';
import { isRecord, assert } from './schema';
import { sha256 } from './receipts';

function primaryValid(primary: Record<string, unknown>): boolean {
  if (primary.kind === 'boundary') return (primary.mode === 'changeStream' || primary.mode === 'oplog') && primary.ts instanceof Timestamp;
  if (primary.kind === 'oplog') return primary.ts instanceof Timestamp;
  return primary.kind === 'changeStream' && isRecord(primary.token) && Object.keys(primary.token).length > 0
    && !Object.hasOwn(primary.token, '_replayFallback');
}

export function checkpointFacts(value: unknown, expectedFeed: string) {
  if (value === null) return { status: 'absent' };
  if (!isRecord(value)) return { status: 'invalid_document' };
  const primary = value.primary;
  const kind = isRecord(primary) && typeof primary.kind === 'string' && ['boundary', 'changeStream', 'oplog'].includes(primary.kind)
    ? primary.kind : 'unsupported';
  return { status: primary == null ? 'missing_primary' : 'present', versionOne: value.version === 1,
    feedMatches: value.feed === expectedFeed, updatedAtIsDate: value.updatedAt instanceof Date && Number.isFinite(value.updatedAt.getTime()),
    primaryKind: kind, primaryValid: isRecord(primary) && primaryValid(primary),
    hasUuidProgress: value.lastCommitToken != null, hasLegacyToken: value.changeStreamToken != null,
    hasRecovery: value.recovery != null };
}

export function checkpointSummary(value: unknown, expectedFeed: string) {
  const facts = checkpointFacts(value, expectedFeed);
  if (facts.status === 'absent' || facts.status === 'missing_primary') return null;
  assert(isRecord(value) && facts.versionOne === true && facts.feedMatches === true && facts.updatedAtIsDate === true
    && facts.primaryValid === true, 'publisher_checkpoint_contract_invalid');
  if (!isRecord(value) || !isRecord(value.primary)) throw new Error('publisher_checkpoint_contract_invalid');
  return { kind: String(value.primary.kind), primaryHash: sha256(JSON.stringify(value.primary)), hasUuidProgress: value.lastCommitToken != null };
}
