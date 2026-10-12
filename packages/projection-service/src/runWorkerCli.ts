import { SealedArtifact } from './artifactIdentity';
import { parseWorkerConfig } from './workerConfig';
import { ConfigError, type Environment } from './configValues';
import { loadDefinitionBundle, DefinitionBundleError } from './definitionBundle';
import { applicationRegistry } from './runtimeRegistry';
import type { RuntimeIdentity, RuntimeRegistry } from './runtimeRegistry';
import type { ExternalConfig } from './infrastructure/mongoConnection';

export async function runWorkerCli(env: Environment, args: readonly string[], directory: string, output: (line: string) => void,
  serve: (identity: RuntimeIdentity, registry: RuntimeRegistry, config: ExternalConfig) => Promise<number>, signal?: AbortSignal): Promise<number> {
  try {
    const { config, modulePath } = parseWorkerConfig(env, args);
    const artifact = await SealedArtifact.read(directory);
    const bundle = await loadDefinitionBundle(modulePath, config.connectTimeoutMs, signal);
    if (signal?.aborted) throw new DefinitionBundleError('definition_bundle_cancelled');
    const { identity, registry } = applicationRegistry(artifact.digest, bundle.moduleHash, bundle.definitions);
    return await serve(identity, registry, config);
  } catch (error) {
    if (error instanceof ConfigError) { output(JSON.stringify({ reason: 'invalid_configuration', variable: error.variable, detail: error.reason })); return 78; }
    output(JSON.stringify({ reason: error instanceof DefinitionBundleError ? error.code : 'worker_start_refused', productionReady: false }));
    return 78;
  }
}
