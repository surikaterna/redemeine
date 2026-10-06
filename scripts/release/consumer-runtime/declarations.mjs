import { writeFile } from 'node:fs/promises';

export function compilerOptions(mode) {
  return {
    target: 'ES2022',
    lib: ['ES2022', 'ESNext.Disposable'],
    module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext',
    moduleResolution: mode,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    noEmit: true,
    types: ['node'],
    typeRoots: ['/opt/consumer-tools/node_modules/@types']
  };
}

function operation(adapter) {
  if (adapter === 'kernel')
    return `
    const command=surface0.createCommand<{amount:number}>('consumer.command')({amount:42});
    const event=surface0.createEvent<{amount:number}>('consumer.event')({amount:42});
    const amount:number=command.payload.amount+event.payload.amount;
    // @ts-expect-error Incorrect payloads must not become any.
    surface0.createCommand<{amount:number}>('consumer.command')({amount:'wrong'});
    export {amount};`;
  if (adapter === 'cli')
    return `
    import type {Contract} from '@redemeine/kernel';
    export const describe=(contract:Contract)=>surface0.describeContract(contract);
    export const extract=surface0.extractZodSchemas;`;
  return 'const value:number=surface0.value; export {value};';
}

export async function declarations(plan, command) {
  for (const syntax of ['import', 'require']) {
    const surfaces = plan.surfaces.filter((surface) => surface.modes.includes(syntax));
    if (!surfaces.length) continue;
    const imports = surfaces
      .map((s, i) =>
        syntax === 'import'
          ? `import * as surface${i} from ${JSON.stringify(s.specifier)}; export const api${i}=surface${i};`
          : `import surface${i}=require(${JSON.stringify(s.specifier)}); export const api${i}=surface${i};`
      )
      .join('\n');
    const file = syntax === 'import' ? 'api.mts' : 'api.cts';
    await writeFile(`/consumer/${file}`, `${imports}\n${operation(plan.adapter)}`);
    for (const mode of syntax === 'import' ? plan.types : ['NodeNext']) {
      await writeFile('/consumer/tsconfig.json', JSON.stringify({ compilerOptions: compilerOptions(mode), files: [file] }));
      command('node', ['/opt/consumer-tools/node_modules/typescript/bin/tsc', '--project', '/consumer/tsconfig.json']);
    }
  }
}
