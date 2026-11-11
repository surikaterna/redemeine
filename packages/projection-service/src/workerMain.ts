#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkerCli } from './runWorkerCli';
import { serveWorker } from './serveWorker';
import { createProcessSignalSource } from './processSignals';

const output = (line: string) => process.stdout.write(`${line}\n`);
const signals = createProcessSignalSource(process); const loading = new AbortController();
const abort = () => loading.abort(); signals.on('SIGTERM', abort); signals.on('SIGINT', abort);
const code = await runWorkerCli(process.env, process.argv.slice(2), dirname(fileURLToPath(import.meta.url)), output,
  (identity, registry, config) => {
    signals.removeListener('SIGTERM', abort); signals.removeListener('SIGINT', abort);
    return serveWorker(identity, registry, config, signals, (code) => process.exit(code), output);
  }, loading.signal);
signals.removeListener('SIGTERM', abort); signals.removeListener('SIGINT', abort);
process.exitCode = code;
if (code === 78) process.exit(78);
