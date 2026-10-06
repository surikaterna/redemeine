import { visit } from 'jsonc-parser';
import { t } from 'tar';
import { demand } from './consumer-schema.mjs';

export function parseJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const stack = [];
  let count = 0;
  const begin = (keys) => {
    demand(stack.length < 64 && ++count <= 200000, 'JSON structural limit exceeded');
    stack.push(keys);
  };
  visit(
    text,
    {
      onObjectBegin: () => begin(new Set()),
      onArrayBegin: () => begin(null),
      onObjectEnd: () => stack.pop(),
      onArrayEnd: () => stack.pop(),
      onObjectProperty: (key) => {
        const keys = stack.at(-1);
        demand(!keys.has(key), 'Duplicate JSON object key');
        keys.add(key);
      },
      onLiteralValue: () => demand(++count <= 200000, 'JSON value limit exceeded'),
      onError: () => demand(false, 'Invalid strict JSON')
    },
    { disallowComments: true, allowTrailingComma: false }
  );
  return JSON.parse(text);
}

// Called only after bounded archive inventory validation; no extraction or execution.
export async function checkArchiveJson(bytes) {
  const chunks = [];
  await new Promise((accept, reject) => {
    const parser = t({
      strict: true,
      onReadEntry: (entry) => {
        if (entry.path === 'package/package.json') entry.on('data', (chunk) => chunks.push(chunk));
        else entry.resume();
      }
    });
    parser.on('error', reject);
    parser.on('end', accept);
    parser.end(bytes);
  });
  parseJson(Buffer.concat(chunks));
}
