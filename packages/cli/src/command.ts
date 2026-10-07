import { parseArgs } from './utils';
import { extractSchemasCommand } from './extractSchemasCommand';
import { extractSchemaRegistriesCommand } from './extractSchemaRegistriesCommand';
import { initAggregate } from './scaffold/initAggregate';
import { addEntity } from './scaffold/addEntity';
import { preflight } from './scaffold/preflight';
import { validName } from './scaffold/paths';

const help = `Available commands:
  init <name> [--no-install]
  add-entity <name> --to <aggregateName> [--no-install]
  extract-schemas --entry <path> --export <name> --out <path> [--kind aggregate|projection] [--format zod|json-schema] [--target draft-7|draft-2020-12] [--tsconfig <path>]
  extract-schema-registries --manifest <path> --out <path>`;

export async function runCommand(argv: string[]): Promise<void> {
  const { command, name, options } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(help);
    return;
  }
  if (command === 'extract-schemas') {
    extractSchemasCommand(options);
    console.log(`${options.format === 'json-schema' ? 'JSON Schema' : 'Zod schemas'} written to ${options.out}`);
    return;
  }
  if (command === 'extract-schema-registries') {
    extractSchemaRegistriesCommand(options);
    console.log(`Schema registries written to ${options.out}`);
    return;
  }
  if (command !== 'init' && command !== 'add-entity') throw new Error(`Unknown command: ${command}\n${help}`);
  validName(name);
  if (command === 'add-entity') validName(options.to);
  await preflight(options['no-install'] === true);
  if (command === 'init') initAggregate(name);
  else addEntity(name, options.to);
}
