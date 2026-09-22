import type { ProjectionCompleteCommitRangeReader } from '@redemeine/projection-runtime-core';
import { assertExactJournal, replayProjectionMigrationRanges, verifyProjectionMigrationSources } from './replay';
import type { ProjectionMigrationActivationPort, ProjectionMigrationManifest, ProjectionMigrationReceipt, ProjectionMigrationReplayPort,
  ProjectionMigrationSnapshotPort, ProjectionMigrationState, ProjectionMigrationStatePort, ProjectionMigrationTrustedPreflightPort } from './types';
import { validateProjectionMigrationManifest } from './validate';

interface ProjectionMigrationEnginePorts {
  states: ProjectionMigrationStatePort;
  preflight: ProjectionMigrationTrustedPreflightPort;
  sourceReader: ProjectionCompleteCommitRangeReader;
  replay: ProjectionMigrationReplayPort;
  snapshot: ProjectionMigrationSnapshotPort;
  activation: ProjectionMigrationActivationPort;
  now?: () => string;
}

function receipt(manifest: ProjectionMigrationManifest, command: ProjectionMigrationReceipt['command'], state: ProjectionMigrationState | null,
  mutated: boolean, reasons: readonly string[] = []): ProjectionMigrationReceipt {
  return { version: 2, command, migrationId: manifest.migrationId, manifestDigest: manifest.manifestDigest,
    status: reasons.length ? 'rejected' : 'ok', phase: state?.phase ?? null, revision: state?.revision ?? null, mutated, reasons,
    ...(state?.replaySnapshot ? { snapshot: state.replaySnapshot } : {}) };
}

export class ProjectionMigrationEngine {
  private readonly now: () => string;
  constructor(private readonly ports: ProjectionMigrationEnginePorts) { this.now = ports.now ?? (() => new Date().toISOString()); }

  async preflight(manifest: ProjectionMigrationManifest, dryRun = false): Promise<ProjectionMigrationReceipt> {
    const reasons = [...validateProjectionMigrationManifest(manifest), ...await this.ports.preflight.inspect(manifest)];
    const current = await this.ports.states.load(manifest.migrationId);
    if (current && current.manifestDigest !== manifest.manifestDigest) reasons.push('migrationId.manifestConflict');
    if (reasons.length || dryRun || current) return receipt(manifest, 'preflight', current, false, reasons);
    return this.transition(manifest, 'preflight', null, { migrationId: manifest.migrationId, manifestDigest: manifest.manifestDigest, phase: 'preflighted' });
  }

  async verifySources(manifest: ProjectionMigrationManifest): Promise<ProjectionMigrationReceipt> {
    const current = await this.require(manifest, ['preflighted', 'sources_verified'], 'verify-sources');
    if ('receipt' in current) return current.receipt;
    if (current.state.phase === 'sources_verified') return receipt(manifest, 'verify-sources', current.state, false);
    try {
      await verifyProjectionMigrationSources(manifest, this.ports.sourceReader, this.ports.states, this.now);
    } catch (error) { return receipt(manifest, 'verify-sources', current.state, false, [message(error)]); }
    return this.transition(manifest, 'verify-sources', current.state, { ...current.state, phase: 'sources_verified' });
  }

  async replay(manifest: ProjectionMigrationManifest): Promise<ProjectionMigrationReceipt> {
    const current = await this.require(manifest, ['sources_verified', 'sources_replayed'], 'replay');
    if ('receipt' in current) return current.receipt;
    if (current.state.phase === 'sources_replayed') return receipt(manifest, 'replay', current.state, false);
    try {
      assertExactJournal(manifest, await this.ports.states.readJournal(manifest.migrationId));
      await replayProjectionMigrationRanges(manifest, this.ports.sourceReader, this.ports.replay);
      const replaySnapshot = await this.ports.snapshot.read();
      return this.transition(manifest, 'replay', current.state, { ...current.state, phase: 'sources_replayed', replaySnapshot });
    } catch (error) { return receipt(manifest, 'replay', current.state, false, [message(error)]); }
  }

  async activate(manifest: ProjectionMigrationManifest): Promise<ProjectionMigrationReceipt> {
    const current = await this.require(manifest, ['sources_replayed', 'activated', 'verified'], 'activate');
    if ('receipt' in current) return current.receipt;
    if (current.state.phase !== 'sources_replayed') return receipt(manifest, 'activate', current.state, false);
    const activated = await this.ports.activation.activate(manifest, current.state);
    return activated ? receipt(manifest, 'activate', activated, true) : receipt(manifest, 'activate', current.state, false, ['activationConflict']);
  }

  async verify(manifest: ProjectionMigrationManifest): Promise<ProjectionMigrationReceipt> {
    const current = await this.require(manifest, ['activated', 'verified'], 'verify');
    if ('receipt' in current) return current.receipt;
    if (current.state.phase === 'verified') return receipt(manifest, 'verify', current.state, false);
    const active = await this.ports.activation.verifyActive(manifest);
    const snapshot = await this.ports.snapshot.read();
    try { assertExactJournal(manifest, await this.ports.states.readJournal(manifest.migrationId)); }
    catch (error) { return receipt(manifest, 'verify', current.state, false, [message(error)]); }
    if (!active || JSON.stringify(snapshot) !== JSON.stringify(current.state.replaySnapshot)) {
      return receipt(manifest, 'verify', current.state, false, ['trustedVerificationMismatch']);
    }
    return this.transition(manifest, 'verify', current.state, { ...current.state, phase: 'verified', verifiedAt: this.now() });
  }

  async rollback(manifest: ProjectionMigrationManifest): Promise<ProjectionMigrationReceipt> {
    const current = await this.require(manifest, ['preflighted', 'sources_verified', 'sources_replayed', 'rolled_back'], 'rollback');
    if ('receipt' in current) return current.receipt;
    if (current.state.phase === 'rolled_back') return receipt(manifest, 'rollback', current.state, false);
    return this.transition(manifest, 'rollback', current.state, { ...current.state, phase: 'rolled_back' });
  }

  private async require(manifest: ProjectionMigrationManifest, phases: readonly ProjectionMigrationState['phase'][],
    command: ProjectionMigrationReceipt['command']): Promise<{ state: ProjectionMigrationState } | { receipt: ProjectionMigrationReceipt }> {
    const issues = validateProjectionMigrationManifest(manifest);
    const state = await this.ports.states.load(manifest.migrationId);
    if (issues.length) return { receipt: receipt(manifest, command, state, false, issues) };
    if (!state || state.manifestDigest !== manifest.manifestDigest) return { receipt: receipt(manifest, command, state, false, ['manifestConflictOrMissing']) };
    if (!phases.includes(state.phase)) {
      const reason = state.phase === 'activated' || state.phase === 'verified' ? 'postActivationForwardRebuildRequired' : 'wrongPhase';
      return { receipt: receipt(manifest, command, state, false, [reason]) };
    }
    return { state };
  }

  private async transition(manifest: ProjectionMigrationManifest, command: ProjectionMigrationReceipt['command'], previous: ProjectionMigrationState | null,
    next: Omit<ProjectionMigrationState, 'revision'>): Promise<ProjectionMigrationReceipt> {
    const state = { ...next, revision: (previous?.revision ?? -1) + 1 };
    const ok = await this.ports.states.compareAndSet(previous?.revision ?? null, state);
    return ok ? receipt(manifest, command, state, true) : receipt(manifest, command, previous, false, ['concurrentChange']);
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
