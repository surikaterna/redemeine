#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const mode = (await readFile('/consumer/fixture-case', 'utf8')).trim();
const source = `import {initialState,accept} from '@redemeine/aggregate';
export const orders={initialState,commandCreators:{accept},pure:{eventProjectors:{
  accepted:(state:typeof initialState,event:ReturnType<typeof accept>)=>({...state,id:event.payload.id,accepted:true})
}}};
`;
const schemas = `import {z} from 'zod';
export const commandSchemas={accept:z.object({id:z.string()})};
export const eventSchemas={accepted:z.object({id:z.string()})};
export const stateSchema=z.object({id:z.string(),accepted:z.boolean()});
`;

// Installed test facade for the checker, NOT the product CLI or a release control.
if (process.argv[2] === 'init') {
  await mkdir('/consumer/src/domains/orders', { recursive: true });
  await writeFile('/consumer/src/domains/orders/aggregate.ts', source + (mode === 'bad-input' ? '\nconst invalid:number="wrong";\n' : ''));
} else if (process.argv[2] === 'extract-schemas') {
  const outputs = {
    valid: schemas,
    syntax: '// z.object id\nexport const = ???',
    comment: '// z.object id\n',
    types: `${schemas}\nexport const invalid:number="wrong";`,
    empty: '// z.object id\nexport const commandSchemas={}; export const eventSchemas={};',
    'coerce-id': schemas.replaceAll('z.string()', 'z.coerce.string()'),
    'coerce-state': schemas.replace('z.boolean()', 'z.coerce.boolean()')
  };
  if (!Object.hasOwn(outputs, mode)) throw new Error(`Unexpected fixture extraction case: ${mode}`);
  await writeFile('/consumer/generated.ts', outputs[mode]);
} else throw new Error('Unexpected fixture CLI command');
