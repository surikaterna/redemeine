#!/usr/bin/env node
import { runCommand } from './command';

runCommand(process.argv).catch((error: unknown) => {
  console.log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
