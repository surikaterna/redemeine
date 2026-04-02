#!/usr/bin/env node

import { colors, parseArgs } from '../src/cli/utils';
import { contractTemplate, aggregateTemplate, selectorsTemplate, entityTemplate, aggregateSpecTemplate, testUtilsTemplate } from '../src/cli/templates';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { exec } from 'child_process';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans);
  }));
}

function runInstall(missing: string[], isDev = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let pm = isDev ? 'npm install -D' : 'npm install';
    if (fs.existsSync(path.resolve(process.cwd(), 'yarn.lock'))) pm = isDev ? 'yarn add -D' : 'yarn add';
    else if (fs.existsSync(path.resolve(process.cwd(), 'pnpm-lock.yaml'))) pm = isDev ? 'pnpm add -D' : 'pnpm add';

    const cmd = `${pm} ${missing.join(' ')}`;
    process.stdout.write(colors.cyan(`Installing ${missing.join(', ')} `));
    
    const interval = setInterval(() => {
      process.stdout.write(colors.cyan('.'));
    }, 500);

    exec(cmd, (error, stdout, stderr) => {
      clearInterval(interval);
      process.stdout.write('\n');
      if (error) {
        console.log(colors.red(`Failed to install dependencies: ${error.message}`));
        reject();
      } else {
        console.log(colors.green('Dependencies installed successfully.'));
        resolve();
      }
    });
  });
}

async function preFlightCheck() {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.log(colors.red('Error: package.json not found. Please run this command at the root of your project.'));
    process.exit(1);
  }

  const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    console.log(colors.cyan('Warning: tsconfig.json not found. You might want to run `tsc --init` or `npm install -D typescript`.'));
  } else {
    try {
      const tsconfigText = fs.readFileSync(tsconfigPath, 'utf-8');
      if (!tsconfigText.includes('"strict": true') && !tsconfigText.includes("'strict': true")) {
         console.log(colors.cyan("Recommendation: Set 'strict: true' in your tsconfig.json to get the full benefit of Redemeine's type-safety."));
      }
      if (tsconfigText.includes('experimentalDecorators') || tsconfigText.includes('emitDecoratorMetadata')) {
         console.log(colors.cyan("Note: Redemeine does not require 'experimentalDecorators' or 'emitDecoratorMetadata'."));
      }
    } catch (e) {
      // Ignore reading errors
    }
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    
    // Check for zod and immer
    const required = ['zod', 'immer'];
    const missing = required.filter(dep => !allDeps[dep]);

    if (missing.length > 0) {
      const ans = await prompt(`Required dependencies (${missing.join(', ')}) are missing. Would you like to install them now? (y/n) `);
      if (ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes') {
        try {
          await runInstall(missing);
        } catch {
          process.exit(1);
        }
      } else {
        console.log(colors.cyan('Proceeding without installing dependencies...'));
      }
    }

    if (!allDeps['jest'] && !allDeps['vitest']) {
      const ans = await prompt(`No testing framework detected. Would you like to scaffold Vitest? (y/n) `);
      if (ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes') {
        try {
          await runInstall(['vitest'], true);
        } catch {
          process.exit(1);
        }
      } else {
        console.log(colors.cyan('Proceeding without installing testing framework...'));
      }
    }
  } catch (err) {
    console.log(colors.red('Error reading project dependencies.'));
    process.exit(1);
  }
}

function initAggregate(name: string) {
  if (!name) {
    console.log(colors.red('Error: Please provide a name for the aggregate.'));
    process.exit(1);
  }

  const domainDir = path.resolve(process.cwd(), `src/domains/\${name}`);
  const mixinsDir = path.join(domainDir, 'mixins');

  if (fs.existsSync(domainDir)) {
    console.log(colors.red(`Error: Aggregate directory '\${name}' already exists.`));
    process.exit(1);
  }

  fs.mkdirSync(domainDir, { recursive: true });
  fs.mkdirSync(mixinsDir, { recursive: true });

  fs.writeFileSync(path.join(domainDir, 'contract.ts'), contractTemplate(name));
  fs.writeFileSync(path.join(domainDir, 'selectors.ts'), selectorsTemplate());
  fs.writeFileSync(path.join(domainDir, 'aggregate.ts'), aggregateTemplate(name));
  fs.writeFileSync(path.join(domainDir, 'aggregate.spec.ts'), aggregateSpecTemplate(name));
  
  const testUtilsPath = path.resolve(process.cwd(), 'src/test-utils.ts');
  if (!fs.existsSync(testUtilsPath)) {
    fs.writeFileSync(testUtilsPath, testUtilsTemplate());
  }

  console.log(colors.green(`Successfully initialized '\${name}' aggregate in src/domains/\${name}/`));
  console.log(colors.green(`🧪 Test suite created! Run \`npm test\` to verify your business logic.`));
}

function addEntity(name: string, aggregateName?: string | boolean) {
  if (!name) {
    console.log(colors.red('Error: Please provide a name for the entity.'));
    process.exit(1);
  }
  
  if (!aggregateName || typeof aggregateName !== 'string') {
    console.log(colors.red('Error: Please provide the target aggregate using --to <aggregateName>'));
    process.exit(1);
  }

  const entitiesDir = path.resolve(process.cwd(), `src/domains/\${aggregateName}/entities`);
  
  if (!fs.existsSync(entitiesDir)) {
    fs.mkdirSync(entitiesDir, { recursive: true });
  }

  const entityFile = path.join(entitiesDir, `\${name}.ts`);
  if (fs.existsSync(entityFile)) {
    console.log(colors.red(`Error: Entity '\${name}' already exists in aggregate '\${aggregateName}'.`));
    process.exit(1);
  }

  fs.writeFileSync(entityFile, entityTemplate(name));
  console.log(colors.green(`Successfully scaffolded entity '\${name}' in src/domains/\${aggregateName}/entities/`));

  // Intelligent Injection Attempt
  const aggregateFile = path.resolve(process.cwd(), `src/domains/\${aggregateName}/aggregate.ts`);
  let injected = false;
  if (fs.existsSync(aggregateFile)) {
    try {
      let content = fs.readFileSync(aggregateFile, 'utf-8');
      const importStatement = `import { \${name}Entity } from './entities/\${name}';\n`;
      const entitiesRegex = /\.entities\(\s*\{([\s\S]*?)\}\s*\)/;
      
      if (entitiesRegex.test(content)) {
        // Safe injection
        if (!content.includes(importStatement.trim())) {
          content = importStatement + content;
        }
        
        content = content.replace(entitiesRegex, (match, inner) => {
          const trimmedInner = inner.trim();
          const separator = trimmedInner.length > 0 && !trimmedInner.endsWith(',') ? ',' : '';
          return `.entities({\n  \${name}: \${name}Entity\${separator}\n\${inner}})`;
        });
        
        fs.writeFileSync(aggregateFile, content);
        injected = true;
        console.log(colors.green(`Successfully injected '\${name}' entity into aggregate.ts.`));
      }
    } catch (e) {
      // Ignore reading/writing errors for injection, handled below
    }
  }

  if (!injected) {
    console.log(colors.cyan(`\nPlease manually add the '\${name}' entity to your aggregate.ts: \n` +
      `1. import { \${name}Entity } from './entities/\${name}';\n` +
      `2. .entities({ ... \${name}: \${name}Entity ... })`));
  }
}

async function main() {
  const { command, name, options } = parseArgs(process.argv);

  if (command !== 'help' && !['init', 'add-entity'].includes(command)) {
    console.log(colors.red(`Unknown command: \${command || '<empty>'}`));
    console.log(colors.cyan('Available commands: init <name>, add-entity <name> --to <aggregateName>'));
    process.exit(1);
  }

  await preFlightCheck();

  switch (command) {
    case 'init':
      initAggregate(name);
      console.log(colors.green('\nNext Steps:'));
      console.log(colors.cyan(`1. Check src/domains/\${name}/contract.ts to define your schema.`));
      console.log(colors.cyan(`2. Run 'bunx redemeine add-entity' to add nested collections.`));
      console.log(colors.cyan(`3. Use 'bunx tsc' to verify your new aggregate.`));
      break;
    case 'add-entity':
      addEntity(name, options.to);
      break;
  }
}

main().catch(err => {
  console.log(colors.red('An unexpected error occurred: ' + err.message));
  process.exit(1);
});
