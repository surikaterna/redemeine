import { existsSync } from 'node:fs';
import { aggregateSpecTemplate, aggregateTemplate, contractTemplate, selectorsTemplate, testUtilsTemplate } from '../templates';
import { safePath, validName } from './paths';
import { writePlan, type NewFile } from './writePlan';

export function initAggregate(input: string, root = process.cwd()): void {
  const name = validName(input);
  const domain = safePath(root, 'src', 'domains', name);
  if (existsSync(domain)) throw new Error(`Aggregate already exists: ${domain}`);
  const files: NewFile[] = [
    { path: safePath(root, domain, 'contract.ts'), content: contractTemplate(name) },
    { path: safePath(root, domain, 'selectors.ts'), content: selectorsTemplate() },
    { path: safePath(root, domain, 'aggregate.ts'), content: aggregateTemplate(name) },
    { path: safePath(root, domain, 'aggregate.spec.ts'), content: aggregateSpecTemplate(name) },
  ];
  const helper = safePath(root, 'src', 'test-utils.ts');
  if (!existsSync(helper)) files.push({ path: helper, content: testUtilsTemplate() });
  const manifest = safePath(root, 'schema-registry.json');
  const entry = { kind: 'aggregate', entry: `./src/domains/${name}/aggregate.ts` };
  if (!existsSync(manifest)) files.push({ path: manifest, content: JSON.stringify({ version: 1, tsconfig: './tsconfig.json', discover: [entry] }, null, 2) + '\n' });
  else console.log(`Existing manifest preserved. Add this discover entry manually: ${JSON.stringify(entry)}`);
  writePlan(root, files, [safePath(root, domain, 'mixins'), safePath(root, domain, 'entities')]);
  console.log(`Created src/domains/${name}. Add @redemeine/cli as a local dev dependency.`);
  console.log('Add this package.json script manually (existing scripts are unchanged):');
  console.log(JSON.stringify({ scripts: { 'schema:generate': 'redemeine extract-schema-registries --manifest schema-registry.json --out src/generated/schema-registries.ts' } }, null, 2));
}
