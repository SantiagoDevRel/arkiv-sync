import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkTree as sdkTree } from './sdk-guidance-guard.mjs';
import { checkTree as vocabularyTree } from './vocabulary-guard.mjs';

const root = JSON.parse(fs.readFileSync('package.json')).name;
const packages = root === 'arkiv-graph-monorepo' ? ['packages/arkiv-graph'] : root === 'arkiv-sync' ? ['.', 'create-arkiv-sync'] : ['.'];
const output = root === 'arkiv-graph-monorepo' ? '.candidate-artifacts' : root === 'arkiv-sync' ? 'artifacts' : 'release-evidence';
fs.mkdirSync(output, { recursive: true });
const evidence = [];
for (const directory of packages) {
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'inspect-pack-'));
  try {
    const args = ['pack', './' + directory, '--ignore-scripts', '--json'];
    const dry = JSON.parse(execFileSync('npm', [...args, '--dry-run'], { encoding: 'utf8' }))[0];
    const actual = JSON.parse(execFileSync('npm', [...args, '--pack-destination', scratch], { encoding: 'utf8' }))[0];
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
  } finally { fs.rmSync(scratch, { recursive: true }); }
}
fs.writeFileSync(path.join(output, 'pack-dry-run.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: 'PASS', packages: evidence.map(p => ({ name: p.name, version: p.version, files: p.files.length })), tarballGuards: true }));
