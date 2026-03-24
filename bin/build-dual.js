const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const tscBin = require.resolve('typescript/bin/tsc');

function runTsc(projectFile) {
  execFileSync(process.execPath, [tscBin, '-p', projectFile], {
    cwd: root,
    stdio: 'inherit'
  });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

fs.rmSync(distDir, { recursive: true, force: true });

runTsc('tsconfig.build.cjs.json');
runTsc('tsconfig.build.esm.json');

writeJson(path.join(distDir, 'cjs', 'package.json'), { type: 'commonjs' });
writeJson(path.join(distDir, 'esm', 'package.json'), { type: 'module' });