import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkTree as sdkTree } from './sdk-guidance-guard.mjs';
import { checkTree as vocabularyTree } from './vocabulary-guard.mjs';
import { createOutputDirectory, withIsolatedCheckout } from './isolated-checkout.mjs';

const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--out', 'Usage: node scripts/inspect-pack.mjs [--out <new-external-directory>]');
withIsolatedCheckout(({ root, temporary, original }) => {
  const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name;
  const packages = name === 'arkiv-graph-monorepo' ? ['packages/arkiv-graph'] : name === 'arkiv-sync' ? ['.', 'create-arkiv-sync'] : ['.'];
  const output = createOutputDirectory(original, args[1], path.join(temporary, 'artifacts'));
  const evidence = [];
  for (const [index, directory] of packages.entries()) {
      const scratch = path.join(output, String(index));
      fs.mkdirSync(scratch);
      const pack = ['pack', './' + directory, '--ignore-scripts', '--json'];
      const options = { cwd: root, encoding: 'utf8' };
      const dry = JSON.parse(execFileSync('npm', [...pack, '--dry-run'], options))[0];
      const actual = JSON.parse(execFileSync('npm', [...pack, '--pack-destination', scratch], options))[0];
      assert.deepEqual(dry.files, actual.files);
      assert(dry.files.some(f => f.path === 'README.md'));
      assert(dry.files.some(f => f.path === 'AGENTS.md'));
      assert(!dry.files.some(f => /(?:^|\/)(?:\.env(?!\.example)|node_modules|\.git)(?:\/|$)|\.(?:pem|key)$/.test(f.path)));
      execFileSync('tar', ['-xzf', path.join(scratch, actual.filename), '-C', scratch]);
      const unpacked = path.join(scratch, 'package');
      const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json')));
      if (manifest.name !== 'create-arkiv-sync') assert.equal(manifest.peerDependencies['@arkiv-network/sdk'], '^1.0.0');
      const prefix = directory === '.' ? '' : directory + '/';
      assert.deepEqual(sdkTree(unpacked, prefix), [], 'packed SDK guidance');
      assert.deepEqual(vocabularyTree(unpacked), [], 'packed vocabulary, including every source-map string');
      evidence.push({ name: dry.name, version: dry.version, integrity: actual.integrity, shasum: actual.shasum, files: dry.files.map(f => f.path) });
  }
  fs.writeFileSync(path.join(output, 'pack-dry-run.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'PASS', output, packages: evidence.map(p => ({ name: p.name, version: p.version, files: p.files.length })), tarballGuards: true }));
}, { prefix: 'inspect-pack-', retain: args.length === 0 });
