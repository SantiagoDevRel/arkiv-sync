import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const name = JSON.parse(fs.readFileSync('package.json')).name;
const graph = name === 'arkiv-graph-monorepo', p2e = name === 'postgres-to-entity';
const files = graph ? ['packages/arkiv-graph/package.json', 'apps/example/package.json', 'pnpm-lock.yaml'] : ['package.json', 'package-lock.json', ...(p2e ? ['sample/package.json', 'sample/package-lock.json'] : [])];
const originals = new Map(files.map(f => [f, fs.readFileSync(f)]));
const version = [1, 0, 0].join('.');
const run = (command, args, cwd = '.') => execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true', SDK_TEST_VERSION: version } });
try {
  if (graph) {
    for (const file of files.filter(f => f.endsWith('package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(file));
      for (const field of ['devDependencies', 'dependencies']) if (pkg[field]?.['@arkiv-network/sdk']) pkg[field]['@arkiv-network/sdk'] = version;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    }
    run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts']);
    run('pnpm', ['test']);
    run('pnpm', ['test:wallet']);
    run('pnpm', ['exec', 'vitest', 'run', 'scripts/graph-writer.test.ts']);
  } else {
    run('npm', ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '@arkiv-network/sdk@' + version]);
    run('npm', ['test']);
    if (p2e) {
      run('npm', ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '@arkiv-network/sdk@' + version], 'sample');
      run(process.execPath, ['--experimental-strip-types', '--test', 'scripts/write-operation.test.ts', 'scripts/write-policy.test.ts'], 'sample');
    }
  }
  assert.equal(JSON.parse(fs.readFileSync('node_modules/@arkiv-network/sdk/package.json')).version, version);
  run(process.execPath, ['scripts/sdk-runtime-check.mjs']);
} finally {
  for (const [file, bytes] of originals) fs.writeFileSync(file, bytes);
  if (graph) run('pnpm', ['install', '--frozen-lockfile']);
  else {
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    if (p2e) run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'sample');
  }
}
assert.equal(JSON.parse(fs.readFileSync('node_modules/@arkiv-network/sdk/package.json')).version, '1.0.1');
for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes, file + ' restored exactly');
console.log(JSON.stringify({ status: 'PASS', peerBaseline: version, restoredSdk: '1.0.1', manifestsUnchanged: true }));
