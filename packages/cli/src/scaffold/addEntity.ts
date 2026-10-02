import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { aggregateTemplate, entityTemplate } from '../templates';
import { safePath, validName } from './paths';
import { writePlan } from './writePlan';

function generatedMounts(content: string, aggregate: string): string[] | undefined {
  const mounts = [...content.matchAll(/^import \{ ([a-z][A-Za-z0-9]*)Entity as _entity_\1 \} from '\.\/entities\/\1';$/gm)].map(match => match[1]);
  if (mounts.some(name => !name)) return undefined;
  const names = mounts.filter((name): name is string => name !== undefined);
  if (new Set(names).size !== names.length || names.some(name => validName(name) !== name)) return undefined;
  return content === aggregateTemplate(aggregate, names) ? names : undefined;
}

export function addEntity(input: string, target: unknown, root = process.cwd()): void {
  const name = validName(input);
  const aggregate = validName(target);
  const aggregateFile = safePath(root, 'src', 'domains', aggregate, 'aggregate.ts');
  if (!existsSync(aggregateFile)) throw new Error(`Target aggregate not found: ${aggregateFile}`);
  const content = readFileSync(aggregateFile, 'utf8');
  const mounts = generatedMounts(content, aggregate);
  if (mounts?.includes(name)) throw new Error(`Entity already mounted: ${name}`);
  const entityFile = safePath(root, 'src', 'domains', aggregate, 'entities', `${name}.ts`);
  writePlan(root, [{ path: entityFile, content: entityTemplate(name) }]);
  if (mounts) {
    safePath(root, aggregateFile);
    if (readFileSync(aggregateFile, 'utf8') !== content) throw new Error('Aggregate changed during generation; mount entity manually.');
    writeFileSync(aggregateFile, aggregateTemplate(aggregate, [...mounts, name]));
  } else console.log(`Aggregate preserved. Manually import { ${name}Entity as _entity_${name} } from './entities/${name}' and add ${name}: _entity_${name} to .entities({...}).`);
}
