import { readFile, readdir, writeFile } from 'node:fs/promises';
import { sha256, protectedManifest, verifyRuntime, inputHashes } from './artifact-inputs.mjs';

const directory = process.argv[2] ?? 'dist';
if (!['dist', 'dist-worker'].includes(directory) || process.argv.length > 3) throw new Error('artifact_directory_refused');
await verifyRuntime();
const names = (await readdir(directory)).filter((name) => name.endsWith('.js')).sort();
if (names.length !== 1 || names[0] !== 'main.js') throw new Error('unexpected_build_outputs');
const files = { 'main.js': sha256(await readFile(`${directory}/main.js`)) };
const lockDigest = sha256(await readFile('../../pnpm-lock.yaml'));
const inputs = await inputHashes(directory);
const payload = { version: 1, files, lockDigest, inputs, protectedManifest };
const digest = sha256(JSON.stringify(payload));
await writeFile(`${directory}/build-lock.sha256`, `${lockDigest}\n`, { mode: 0o600 });
await writeFile(`${directory}/artifact.json`, `${JSON.stringify({ ...payload, digest }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ directory, artifact: digest, protectedManifest }));
