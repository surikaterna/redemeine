import { types } from 'node:util';
import { enablePatches, Immer, type Draft } from 'immer';
import { formatProjectionChangePointer } from './projectionChangePatch';
import type { ProjectionChangePatchOperation, ProjectionChangeTransition } from './projectionChanges';
import type { ProjectionJsonValue, ProjectionSourceEvent } from './sourceCommit';
import type { CommitProjectionSourceCommitRequest, ProjectionSourceCommitProgress } from './sourceCommitStore';

const owned = new WeakSet<object>();
const captures = new WeakMap<ProjectionChangeTransition, { before: unknown; after: unknown; creating: boolean }>();
const sealedRequests = new WeakSet<object>();
const immer = new Immer({ autoFreeze: true });
const objectPrototypes = new Set([Object.prototype, Object.getPrototypeOf(structuredClone({})), null]);
const arrayPrototypes = new Set([Array.prototype, Object.getPrototypeOf(structuredClone([]))]);
let patchesEnabled = false;

export function isOwnedProjectionState(value: unknown): boolean {
  return value !== null && typeof value === 'object' && owned.has(value);
}

function plainContainer(value: object): boolean {
  if (types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (Array.isArray(value) ? arrayPrototypes : objectPrototypes).has(prototype);
}

/** Seal detached data, not validate its JSON schema. Already owned branches are not visited. */
export function ownProjectionState(root: unknown): boolean {
  const pending = [{ value: root, exit: false }];
  const active = new WeakSet<object>();
  while (pending.length) {
    const { value, exit } = pending.pop()!;
    if (typeof value === 'function' || typeof value === 'symbol') return false;
    if (!value || typeof value !== 'object' || owned.has(value)) continue;
    if (exit) {
      Object.freeze(value);
      owned.add(value);
      active.delete(value);
      continue;
    }
    if (active.has(value) || !plainContainer(value)) return false;
    active.add(value);
    pending.push({ value, exit: true });
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !('value' in field)) return false;
      pending.push({ value: field.value, exit: false });
    }
  }
  return true;
}

/** Only this actual Immer execution can mint an immutable capture; callers cannot attest a supplied patch. */
export function captureProjectionSourceEvent<T>(
  before: T, event: ProjectionSourceEvent, recipe: (draft: Draft<T>) => void, creating: boolean
): { state: T; transition?: ProjectionChangeTransition } {
  if (!patchesEnabled) {
    enablePatches();
    patchesEnabled = true;
  }
  const stableBefore = ownProjectionState(before);
  const [state, native] = creating ? [immer.produce(before, recipe), []] : immer.produceWithPatches(before, recipe);
  if (!stableBefore || !ownProjectionState(state)) return { state };
  const patch: ProjectionChangePatchOperation[] = creating
    ? [{ op: 'add', path: '', value: state as ProjectionJsonValue }]
    : native.map(({ op, path, value }) => op === 'remove' ? { op, path: formatProjectionChangePointer(path) }
      : { op, path: formatProjectionChangePointer(path), value: value as ProjectionJsonValue });
  for (const op of patch) {
    if (op.op !== 'remove' && !ownProjectionState(op.value)) return { state };
    Object.freeze(op);
  }
  const transition = Object.freeze({ eventId: event.eventId, eventIndex: event.eventIndex,
    changeType: creating ? 'create' : patch.length ? 'update' : 'noop', patch: Object.freeze(patch) } as const);
  captures.set(transition, { before, after: state, creating });
  return { state, transition };
}

export function matchesCapturedProjectionState(
  before: unknown, exists: boolean, after: unknown, transitions: readonly ProjectionChangeTransition[]
): boolean {
  if (!transitions.length) return false;
  for (const transition of transitions) {
    const capture = captures.get(transition);
    if (!capture || capture.creating === exists || (exists && !Object.is(capture.before, before))) return false;
    before = capture.after;
    exists = true;
  }
  return Object.is(before, after);
}

function sealProgress(progress: ProjectionSourceCommitProgress): ProjectionSourceCommitProgress {
  if (progress.strategy === 'none') return Object.freeze({ ...progress });
  const warnings = progress.warnings ? { warnings: Object.freeze({ ...progress.warnings }) } : {};
  if (progress.strategy === 'own_record') return Object.freeze({ ...progress, ...warnings, source: Object.freeze({ ...progress.source }) });
  return Object.freeze({ ...progress, ...warnings, targets: Object.freeze(progress.targets.map((entry) => Object.freeze({
    ...entry, expected: Object.freeze({ ...entry.expected }), final: Object.freeze({ ...entry.final })
  }))) });
}

/** Seal routing and receipt inputs; no state copies or revalidation of captured payloads. */
export function sealProjectionCaptureRequest<T>(request: CommitProjectionSourceCommitRequest<T>): CommitProjectionSourceCommitRequest<T> {
  const append = request.additionalWrites?.[0];
  const sequences = new Map<readonly ProjectionChangeTransition[], readonly ProjectionChangeTransition[]>();
  const sequence = (original: readonly ProjectionChangeTransition[]) => {
    const frozen = sequences.get(original) ?? Object.freeze([...original]);
    sequences.set(original, frozen);
    return frozen;
  };
  const events = Object.freeze(request.commit.events.map((event) => Object.freeze({ ...event })));
  const sealed = Object.freeze({
    ...request,
    commit: Object.freeze({ ...request.commit, events: events as unknown as typeof request.commit.events }),
    finalDocuments: Object.freeze(request.finalDocuments.map((document) => Object.freeze({
      ...document,
      ...(document.statePatch?.kind === 'ordered' ? {
        statePatch: Object.freeze({ ...document.statePatch, transitions: sequence(document.statePatch.transitions) })
      } : {})
    }))),
    progress: sealProgress(request.progress),
    stagedLinks: Object.freeze(request.stagedLinks.map((link) => Object.freeze({ ...link }))),
    ...(append ? { additionalWrites: Object.freeze([Object.freeze({ ...append, targets: Object.freeze(append.targets.map((target) =>
      Object.freeze({ ...target, transitions: sequence(target.transitions) }))) })] as const) } : {})
  });
  sealedRequests.add(sealed);
  return sealed;
}

export function isSealedProjectionCaptureRequest(request: CommitProjectionSourceCommitRequest): boolean {
  return sealedRequests.has(request);
}
