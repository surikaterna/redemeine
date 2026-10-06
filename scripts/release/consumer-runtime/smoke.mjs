import assert from 'node:assert/strict';
import { cliGeneration } from './cli-generation.mjs';
import { declarations } from './declarations.mjs';
import { behaviorCommands, surfaceCommands } from './smoke-commands.mjs';

export async function smoke(job, command, result) {
  for (const plan of job.smokes) {
    for (const entry of surfaceCommands(plan)) command(entry.program, entry.args);
    await behavior(plan, command, result);
    result.phases.runtime = 'passed';
    await declarations(plan, command);
    result.phases.types = 'passed';
  }
}

async function behavior(plan, command, result) {
  if (plan.adapter === 'cli') return cliBehavior(plan, command, result);
  for (const entry of behaviorCommands(plan)) command(entry.program, entry.args);
}

async function cliBehavior(plan, command, result) {
  const [helpCommand, apiCommand] = behaviorCommands(plan);
  const help = command(helpCommand.program, helpCommand.args);
  assert(help.includes('extract-schemas') && help.includes('init'), 'Installed CLI help lacks commands');
  command(apiCommand.program, apiCommand.args);
  result.phases.cliApi = 'passed';
  await declarations(plan, command);
  result.phases.cliDeclarations = 'passed';
  await cliGeneration(command, result);
}
