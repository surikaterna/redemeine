#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './runCli';
import { serveReference } from './serveReference';
import { serveExternal } from './infrastructure/external';
import { createProcessSignalSource } from './processSignals';

const output = (message: string) => process.stdout.write(`${message}\n`);
const signals = createProcessSignalSource(process);
process.exitCode = await runCli(process.env, process.argv.slice(2), dirname(fileURLToPath(import.meta.url)),
  output, (artifact, config) => (config.mode === 'reference' ? serveReference : serveExternal)(
    artifact, config, signals, (code) => process.exit(code), output));
