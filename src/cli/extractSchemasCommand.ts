import { resolve } from 'node:path';
import { extractZodSchemas } from './extractZodSchemas';
import { extractProjectionSchemas } from './extractProjectionSchemas';

export function extractSchemasCommand(options: Record<string, string | boolean>): void {
  const entry = requiredOption(options, 'entry');
  const exportName = requiredOption(options, 'export');
  const outFile = requiredOption(options, 'out');
  const kind = options.kind ?? 'aggregate';
  if (kind !== 'aggregate' && kind !== 'projection') throw new Error('--kind must be aggregate or projection');
  const tsconfig = resolve(typeof options.tsconfig === 'string' ? options.tsconfig : 'tsconfig.json');
  const shared = { tsconfig, entry: resolve(entry), outFile: resolve(outFile) };
  if (kind === 'projection') {
    if ('no-state' in options || 'date-handling' in options) {
      throw new Error('--no-state and --date-handling are not supported for --kind projection');
    }
    extractProjectionSchemas({ ...shared, projectionExport: exportName });
    return;
  }
  extractZodSchemas({
    ...shared,
    aggregateExport: exportName,
    dateHandling: typeof options['date-handling'] === 'string' ? options['date-handling'] as 'string' | 'date' : 'string',
    includeState: !(options['no-state'] === true || options['no-state'] === 'true')
  });
}

function requiredOption(options: Record<string, string | boolean>, name: string): string {
  const value = options[name];
  if (!value || typeof value !== 'string') throw new Error(`--${name} <${name === 'export' ? 'name' : 'path'}> is required.`);
  return value;
}
