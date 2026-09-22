import type {
  ProjectionMigrationManifest, ProjectionMigrationQuiesceEvidence, ProjectionMigrationReceipt, ProjectionMigrationRegistryPort, ProjectionMigrationReplayEvidence,
  ProjectionMigrationState, ProjectionMigrationStatePort, ProjectionMigrationVerification
} from './types';
import { validateProjectionMigrationManifest } from './validate';

function receipt(manifest: ProjectionMigrationManifest, command: ProjectionMigrationReceipt['command'], state: ProjectionMigrationState | null,
  mutated: boolean, reasons: readonly string[] = []): ProjectionMigrationReceipt {
  return { version: 1, command, migrationId: manifest.migrationId, manifestDigest: manifest.manifestDigest, status: reasons.length ? 'rejected' : 'ok',
    phase: state?.phase ?? null, revision: state?.revision ?? null, mutated, reasons };
}

async function persist(port: ProjectionMigrationStatePort, previous: ProjectionMigrationState | null,
  next: Omit<ProjectionMigrationState, 'revision'>): Promise<ProjectionMigrationState | null> {
  const state = { ...next, revision: (previous?.revision ?? -1) + 1 };
  return await port.compareAndSet(previous?.revision ?? null, state) ? state : null;
}

export class ProjectionMigrationEngine {
  constructor(private readonly states: ProjectionMigrationStatePort, private readonly registry: ProjectionMigrationRegistryPort,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async preflight(manifest: ProjectionMigrationManifest, dryRun = false): Promise<ProjectionMigrationReceipt> {
    const reasons = validateProjectionMigrationManifest(manifest);
    const current = await this.states.load(manifest.migrationId);
    if (current && current.manifestDigest !== manifest.manifestDigest) return receipt(manifest, 'preflight', current, false, ['migrationId.manifestConflict']);
    if (reasons.length || dryRun || current) return receipt(manifest, 'preflight', current, false, reasons);
    const state = await persist(this.states, null, { migrationId: manifest.migrationId, manifestDigest: manifest.manifestDigest, phase: 'preflighted' });
    return state ? receipt(manifest, 'preflight', state, true) : receipt(manifest, 'preflight', null, false, ['concurrentChange']);
  }

  async quiesce(manifest: ProjectionMigrationManifest, evidence: ProjectionMigrationQuiesceEvidence): Promise<ProjectionMigrationReceipt> {
    const current = await this.states.load(manifest.migrationId);
    if (current?.phase === 'quiesced') return receipt(manifest, 'quiesce', current, false);
    if (current?.phase !== 'preflighted') return receipt(manifest, 'quiesce', current, false, ['phase.requiresPreflighted']);
    const invalid = evidence.oldQueueDepth !== 0 || evidence.oldActiveWriters !== 0 || evidence.newActiveWriters !== 0;
    if (invalid) return receipt(manifest, 'quiesce', current, false, ['dualWriterOrUndrained']);
    const state = await persist(this.states, current, { ...current, phase: 'quiesced', quiesceEvidence: evidence });
    return state ? receipt(manifest, 'quiesce', state, true) : receipt(manifest, 'quiesce', current, false, ['concurrentChange']);
  }

  async activate(manifest: ProjectionMigrationManifest, replay: ProjectionMigrationReplayEvidence): Promise<ProjectionMigrationReceipt> {
    const current = await this.states.load(manifest.migrationId);
    if (current?.phase === 'activated' || current?.phase === 'verified') return receipt(manifest, 'activate', current, false);
    if (current?.phase !== 'quiesced') return receipt(manifest, 'activate', current, false, ['phase.requiresQuiesced']);
    const replayReasons: string[] = [];
    if (replay.replayedRangesDigest !== manifest.authoritativeSourceDigest) replayReasons.push('replayedRangesDigest');
    if (manifest.snapshot && (replay.stateDigest !== manifest.snapshot.stateDigest || replay.linkDigest !== manifest.snapshot.linkDigest)) replayReasons.push('snapshotDigest');
    if (replayReasons.length) return receipt(manifest, 'activate', current, false, replayReasons);
    const adoption = await this.registry.adopt(manifest.newRegistry);
    if (adoption === 'conflict') return receipt(manifest, 'activate', current, false, ['newRegistry.conflict']);
    const state = await persist(this.states, current, { ...current, phase: 'activated', activatedAt: this.now(), replayEvidence: replay });
    return state ? receipt(manifest, 'activate', state, true) : receipt(manifest, 'activate', current, false, ['concurrentChange']);
  }

  async verify(manifest: ProjectionMigrationManifest, verification: ProjectionMigrationVerification): Promise<ProjectionMigrationReceipt> {
    const current = await this.states.load(manifest.migrationId);
    if (current?.phase === 'verified') return receipt(manifest, 'verify', current, false);
    if (current?.phase !== 'activated') return receipt(manifest, 'verify', current, false, ['phase.requiresActivated']);
    const reasons: string[] = [];
    if (verification.activeWriters !== 1) reasons.push('activeWriters');
    if (verification.replayedRangesDigest !== manifest.authoritativeSourceDigest) reasons.push('replayedRangesDigest');
    if (current.replayEvidence && (verification.stateDigest !== current.replayEvidence.stateDigest || verification.linkDigest !== current.replayEvidence.linkDigest)) reasons.push('replayStateChanged');
    if (manifest.snapshot && (verification.stateDigest !== manifest.snapshot.stateDigest || verification.linkDigest !== manifest.snapshot.linkDigest)) reasons.push('snapshotDigest');
    if (reasons.length) return receipt(manifest, 'verify', current, false, reasons);
    const state = await persist(this.states, current, { ...current, phase: 'verified', verification });
    return state ? receipt(manifest, 'verify', state, true) : receipt(manifest, 'verify', current, false, ['concurrentChange']);
  }

  async rollback(manifest: ProjectionMigrationManifest, reason: string, oldFeedAvailable: boolean,
    conflictingWrites: boolean): Promise<ProjectionMigrationReceipt> {
    const current = await this.states.load(manifest.migrationId);
    if (current?.phase === 'rolled_back') return receipt(manifest, 'rollback', current, false);
    if (!current || current.phase === 'preflighted') return receipt(manifest, 'rollback', current, false, ['phase.requiresQuiesced']);
    if (!manifest.retainOldArtifacts || !oldFeedAvailable || conflictingWrites) return receipt(manifest, 'rollback', current, false, ['manualRebuildRequired']);
    const state = await persist(this.states, current, { ...current, phase: 'rolled_back', rollbackReason: reason });
    return state ? receipt(manifest, 'rollback', state, true) : receipt(manifest, 'rollback', current, false, ['concurrentChange']);
  }
}
