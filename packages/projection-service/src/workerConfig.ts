import { parseConfig } from './config';
import { ConfigError, type Environment } from './configValues';

export function parseWorkerConfig(env: Environment, args: readonly string[]) {
  if (env.PROJECTION_MODE !== undefined && env.PROJECTION_MODE !== 'external') throw new ConfigError('PROJECTION_MODE', 'external_required');
  if (env.PROJECTION_EXECUTION !== undefined && env.PROJECTION_EXECUTION !== 'serve') throw new ConfigError('PROJECTION_EXECUTION', 'serve_required');
  const { PROJECTION_DEFINITIONS_MODULE: modulePath, ...settings } = env;
  const config = parseConfig({ ...settings, PROJECTION_MODE: 'external', PROJECTION_EXECUTION: 'serve' }, args);
  if (!modulePath) throw new ConfigError('PROJECTION_DEFINITIONS_MODULE', 'required');
  if (config.mode !== 'external') throw new ConfigError('PROJECTION_MODE', 'external_required');
  return Object.freeze({ config, modulePath });
}
