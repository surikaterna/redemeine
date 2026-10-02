export function generateProjectionOutput(schema: string): string {
  return [
    '// Generated projection business-state schemas. Requires Zod 4.',
    "import { z } from 'zod';",
    '',
    `export const stateSchema = ${schema};`,
    'export const stateJsonSchema = z.toJSONSchema(stateSchema);',
    ''
  ].join('\n');
}
