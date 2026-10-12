import { SealedArtifact } from './artifactIdentity';
import { fixtureRegistryDigest } from './fixtureRegistry';

export class VerifiedArtifact {
  readonly registryDigest: string;
  private constructor(readonly digest: string) { this.registryDigest = fixtureRegistryDigest(digest); Object.freeze(this); }
  static async read(directory: string): Promise<VerifiedArtifact> { return new VerifiedArtifact((await SealedArtifact.read(directory)).digest); }
}
