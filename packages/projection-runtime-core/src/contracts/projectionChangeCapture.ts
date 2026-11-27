import { types } from 'node:util';
import { enablePatches, Immer, type Draft } from 'immer';
import type { JoinSeedProvenance } from '../joinSeed';
import { freezeJoinSeedEdges, freezeJoinSeedProvenance } from './joinSeedProvenance';
import { formatProjectionChangePointer } from './projectionChangePatch';
import type { ProjectionChangePatchOperation, ProjectionChangeTransition } from './projectionChanges';
import type { ProjectionJsonValue, ProjectionSourceEvent } from './sourceCommit';
import type { CommitProjectionSourceCommitRequest, ProjectionSourceCommitProgress, ProjectionSourceCommitSnapshot } from './sourceCommitStore';

const owned = new WeakSet<object>();
const nativeSnapshots = new WeakSet<ProjectionSourceCommitSnapshot>();
type NativeCaptureOrigin = { snapshot: ProjectionSourceCommitSnapshot; targetId: string };
const captures = new WeakMap<ProjectionChangeTransition, {
  before: unknown; after: unknown; creating: boolean; origin: NativeCaptureOrigin | undefined
}>();
const sealedRequests = new WeakSet<object>();
const immer = new Immer({ autoFreeze: true });
const nativeImmer = new Immer({ autoFreeze: false });
const objectPrototypes = new Set([Object.prototype, Object.getPrototypeOf(structuredClone({})), null]);
const arrayPrototypes = new Set([Array.prototype, Object.getPrototypeOf(structuredClone([]))]);
let patchesEnabled = false;

export function isOwnedProjectionState(value: unknown): boolean {
  return value !== null && typeof value === 'object' && owned.has(value);
}

/** @internal Reducer hint only; adapters still require private, same-store snapshot provenance. */
export function registerNativeProjectionCaptureSnapshot(snapshot: ProjectionSourceCommitSnapshot): void {
  nativeSnapshots.add(snapshot);
}

/** @internal */
export function isNativeProjectionCaptureSnapshot(snapshot: ProjectionSourceCommitSnapshot): boolean {
  return nativeSnapshots.has(snapshot);
}

function plainContainer(value: object): boolean {
  if (types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (Array.isArray(value) ? arrayPrototypes : objectPrototypes).has(prototype);
}

/** Seal detached data, not validate its JSON schema. Already owned branches are not visited. */
export function ownProjectionState(root: unknown): boolean {
  if (typeof root === 'function' || typeof root === 'symbol') return false;
  if (!root || typeof root !== 'object' || owned.has(root)) return true;
  const pending: (object | undefined)[] = [root];
  const active = new Set<object>();
  const checked = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value === undefined) {
      const completed = pending.pop()!;
      active.delete(completed);
      checked.add(completed);
      continue;
    }
    if (checked.has(value) || owned.has(value)) continue;
    if (active.has(value) || !plainContainer(value)) return false;
    active.add(value);
    pending.push(value, undefined);
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !('value' in field)) return false;
      const child: unknown = field.value;
      if (typeof child === 'function' || typeof child === 'symbol') return false;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  // Publish ownership only after the whole input has passed and every new node is frozen.
  for (const value of checked) Object.freeze(value);
  for (const value of checked) owned.add(value);
  return true;
}

/** Only an actual Immer execution mints a capture. Native payloads follow the synchronous draft-only contract. */
export function captureProjectionSourceEvent<T>(
  before: T, event: ProjectionSourceEvent, recipe: (draft: Draft<T>) => void, creating: boolean,
  native?: NativeCaptureOrigin, seedProvenance?: () => readonly JoinSeedProvenance[]
): { state: T; transition?: ProjectionChangeTransition } {
  if (!patchesEnabled) {
    enablePatches();
    patchesEnabled = true;
  }
  const origin = native && nativeSnapshots.has(native.snapshot) ? { ...native } : undefined;
  const engine = origin ? nativeImmer : immer;
  const stableBefore = origin || ownProjectionState(before);
  const [state, patches] = creating ? [engine.produce(before, recipe), []] : engine.produceWithPatches(before, recipe);
  if (!stableBefore || (!origin && !ownProjectionState(state))) return { state };
  const patch: ProjectionChangePatchOperation[] = creating
    ? [{ op: 'add', path: '', value: state as ProjectionJsonValue }]
    : patches.map(({ op, path, value }) => op === 'remove' ? { op, path: formatProjectionChangePointer(path) }
      : { op, path: formatProjectionChangePointer(path), value: value as ProjectionJsonValue });
  for (const op of patch) {
    if (!origin && op.op !== 'remove' && !ownProjectionState(op.value)) return { state };
    Object.freeze(op);
  }
  const seeds = seedProvenance?.();
  const transition = Object.freeze({ eventId: event.eventId, eventIndex: event.eventIndex,
    changeType: creating ? 'create' : patch.length ? 'update' : 'noop', patch: Object.freeze(patch),
    ...(seeds?.length ? { joinSeeds: Object.freeze(seeds.map(freezeJoinSeedProvenance)) } : {}) } as const);
  captures.set(transition, { before, after: state, creating, origin });
  return { state, transition };
}

export function matchesCapturedProjectionState(
  before: unknown, exists: boolean, after: unknown, transitions: readonly ProjectionChangeTransition[],
  origin?: NativeCaptureOrigin
): boolean {
  if (!transitions.length) return false;
  for (const transition of transitions) {
    const capture = captures.get(transition);
    if (!capture || capture.origin?.snapshot !== origin?.snapshot || capture.origin?.targetId !== origin?.targetId
      || capture.creating === exists || (exists && !Object.is(capture.before, before))) return false;
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
    ...(request.joinMembershipFences ? { joinMembershipFences: Object.freeze(request.joinMembershipFences.map((fence) =>
      Object.freeze({ ...fence, targetDocumentIds: Object.freeze([...fence.targetDocumentIds]),
        ...(fence.seeds ? { seeds: freezeJoinSeedEdges(fence.seeds) } : {}) }))) } : {}),
    ...(append ? { additionalWrites: Object.freeze([Object.freeze({ ...append, targets: Object.freeze(append.targets.map((target) =>
      Object.freeze({ ...target, transitions: sequence(target.transitions) }))) })] as const) } : {})
  });
  sealedRequests.add(sealed);
  return sealed;
}

export function isSealedProjectionCaptureRequest(request: CommitProjectionSourceCommitRequest): boolean {
  return sealedRequests.has(request);
}
