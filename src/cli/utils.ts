export const colors = {
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  reset: '\x1b[0m'
};

export function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0];
  const name = args[1];
  const options: Record<string, string | boolean> = {};

  for (let i = ['extract-schemas', 'extract-schema-registries'].includes(command) ? 1 : 2; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace('--', '');
      if (command === 'extract-schema-registries' && !['manifest', 'out'].includes(key)) throw new Error(`unknown option --${key}`);
      if (command === 'extract-schema-registries' && Object.hasOwn(options, key)) throw new Error(`duplicate option --${key}`);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
    } else if (command === 'extract-schema-registries') throw new Error(`unexpected argument ${args[i]}`);
  }

  return { command, name, options };
}
