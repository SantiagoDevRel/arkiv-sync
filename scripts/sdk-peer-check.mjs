import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withIsolatedCheckout } from './isolated-checkout.mjs';
const version = [1, 0, 0].join('.');
withIsolatedCheckout(({ root }) => {
  const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name;
  const graph = name === 'arkiv-graph-monorepo', p2e = name === 'postgres-to-entity';
  const run = (command, args, directory = '.') => execFileSync(command, args, { cwd: path.join(root, directory), stdio: 'inherit', env: { ...process.env, CI: 'true', SDK_TEST_VERSION: version } });
  if (graph) {
    for (const file of ['packages/arkiv-graph/package.json', 'apps/example/package.json']) {
      const target = path.join(root, file);
      const pkg = JSON.parse(fs.readFileSync(target));
      for (const field of ['devDependencies', 'dependencies']) if (pkg[field]?.['@arkiv-network/sdk']) pkg[field]['@arkiv-network/sdk'] = version;
      fs.writeFileSync(target, JSON.stringify(pkg, null, 2) + '\n');
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@arkiv-network/sdk/package.json'))).version, version);
  run(process.execPath, ['scripts/sdk-runtime-check.mjs']);
  console.log(JSON.stringify({ status: 'PASS', peerBaseline: version, isolatedSdkSwitch: true }));
}, { prefix: 'sdk-peer-check-' });
