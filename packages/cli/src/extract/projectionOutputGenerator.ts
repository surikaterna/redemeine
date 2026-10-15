export function generateProjectionOutput(schema: string, imports: string[] = []): string {
  return [
    '// Generated projection business-state schemas. Requires Zod 4.',
    "import { z } from 'zod';",
    ...imports,
    '',
    `export const stateSchema = ${schema};`,
    'export const stateJsonSchema = z.toJSONSchema(stateSchema);',
    ''
  ].join('\n');
}
