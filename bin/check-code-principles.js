#!/usr/bin/env node

const { runCodePrinciplesChecks } = require('./code-principles-checks');

function main() {
  const result = runCodePrinciplesChecks();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`❌ ${violation}`);
    }

    process.exit(1);
  }

  console.log(`✅ Code principles checks passed (${result.scannedFiles.length} files scanned).`);
}

main();
