export type ProjectionJsonPrimitive = string | number | boolean | null;
export type ProjectionJsonValue =
  | ProjectionJsonPrimitive
  | ProjectionJsonValue[]
  | { [key: string]: ProjectionJsonValue };
export type ProjectionJsonObject = { [key: string]: ProjectionJsonValue };

export interface ProjectionSourceCheckpoint {
  /** Last applied commit sequence. Absence is represented outside this value, never as zero. */
  sequence: number;
}

export interface ProjectionSourceEvent {
  eventId: string;
  eventIndex: number;
  streamVersion: number;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: ProjectionJsonObject;
  timestamp: string;
  headers?: ProjectionJsonObject;
  metadata?: ProjectionJsonObject;
}

export interface ProjectionSourceCommit {
  streamId: string;
  commitId: string;
  commitSequence: number;
  events: readonly [ProjectionSourceEvent, ...ProjectionSourceEvent[]];
  headers?: ProjectionJsonObject;
  metadata?: ProjectionJsonObject;
}

export interface ProjectionSourceCommitValidationSuccess {
  valid: true;
  value: ProjectionSourceCommit;
}

export interface ProjectionSourceCommitValidationFailure {
  valid: false;
  issues: readonly string[];
}

export type ProjectionSourceCommitValidationResult =
  | ProjectionSourceCommitValidationSuccess
  | ProjectionSourceCommitValidationFailure;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalProjectionUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isProjectionJsonValue(value: unknown): value is ProjectionJsonValue {
  const pending: Array<{ value: unknown; exiting: boolean }> = [{ value, exiting: false }];
  const active = new WeakSet<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) continue;
    const current = entry.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number' && Number.isFinite(current)) continue;
    if (!current || typeof current !== 'object') return false;
    if (entry.exiting) {
      active.delete(current);
      continue;
    }
    if (active.has(current)) return false;
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype) return false;
    if (!Array.isArray(current) && Reflect.ownKeys(current).length !== Object.keys(current).length) return false;
    active.add(current);
    pending.push({ value: current, exiting: true });
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      pending.push({ value: child, exiting: false });
    }
  }
  return true;
}

function isProjectionJsonObject(value: unknown): value is ProjectionJsonObject {
  return isProjectionJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === 'object';
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateEvent(candidate: unknown, index: number, firstVersion: number): string[] {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [`events[${index}]`];
  const event = candidate as Record<string, unknown>;
  const issues: string[] = [];
  if (!isCanonicalProjectionUuid(event.eventId)) issues.push(`events[${index}].eventId`);
  if (event.eventIndex !== index) issues.push(`events[${index}].eventIndex`);
  if (event.streamVersion !== firstVersion + index) issues.push(`events[${index}].streamVersion`);
  for (const field of ['aggregateType', 'aggregateId', 'type', 'timestamp'] as const) {
    if (!isNonemptyString(event[field])) issues.push(`events[${index}].${field}`);
  }
  for (const field of ['payload', 'headers', 'metadata'] as const) {
    if (field === 'payload' || event[field] !== undefined) {
      if (!isProjectionJsonObject(event[field])) {
        issues.push(`events[${index}].${field}`);
      }
    }
  }
  return issues;
}

function validateEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0) return ['events'];
  const first = events[0];
  if (!first || typeof first !== 'object' || !isSafeSequence((first as Record<string, unknown>).streamVersion)) {
    return ['events[0].streamVersion'];
  }
  const firstVersion = (first as Record<string, unknown>).streamVersion as number;
  const firstRecord = first as Record<string, unknown>;
  return events.flatMap((event, index) => {
    const issues = validateEvent(event, index, firstVersion);
    if (event && typeof event === 'object') {
      const record = event as Record<string, unknown>;
      if (record.aggregateType !== firstRecord.aggregateType) issues.push(`events[${index}].aggregateType`);
      if (record.aggregateId !== firstRecord.aggregateId) issues.push(`events[${index}].aggregateId`);
    }
    return issues;
  });
}

export function validateProjectionSourceCommit(candidate: unknown): ProjectionSourceCommitValidationResult {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, issues: ['commit'] };
  }
  const commit = candidate as Record<string, unknown>;
  const issues = validateEvents(commit.events);
  if (!isCanonicalProjectionUuid(commit.streamId)) issues.push('streamId');
  if (!isCanonicalProjectionUuid(commit.commitId)) issues.push('commitId');
  if (!isSafeSequence(commit.commitSequence)) issues.push('commitSequence');
  for (const field of ['headers', 'metadata'] as const) {
    if (commit[field] !== undefined && !isProjectionJsonObject(commit[field])) issues.push(field);
  }
  return issues.length === 0
    ? { valid: true, value: candidate as ProjectionSourceCommit }
    : { valid: false, issues };
}
