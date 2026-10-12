import { VerifiedArtifact } from './artifact';
import { parseConfig, type HostConfig } from './config';
import { ConfigError, type Environment } from './configValues';
import { runReference } from './reference/runReference';

export async function runCli(env: Environment, args: readonly string[], artifactDirectory: string,
  output: (message: string) => void,
  serve?: (artifact: VerifiedArtifact, config: HostConfig) => Promise<number>): Promise<number> {
  try {
    const config = parseConfig(env, args);
    if (config.mode === 'external' && config.execution === 'once') {
      output(JSON.stringify({ mode: 'external', productionReady: false, reason: 'external_requires_serve' }));
      return 78;
    }
    const artifact = await VerifiedArtifact.read(artifactDirectory);
    if (config.execution === 'serve') {
      if (!serve) throw new Error('host_unavailable');
      return await serve(artifact, config);
    }
    output(JSON.stringify(await runReference(artifact, config)));
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      output(JSON.stringify({ reason: 'invalid_configuration', variable: error.variable, detail: error.reason }));
      return 78;
    }
    output(JSON.stringify({ reason: 'reference_execution_refused', productionReady: false }));
    return 1;
  }
}
