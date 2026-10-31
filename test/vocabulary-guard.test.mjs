import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTree, violations } from '../scripts/vocabulary-guard.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
test('complete tree uses current vocabulary, including generated files', () => {
  assert.deepEqual(checkTree(root), []);
});
test('guard CLI rejects injected mixed-case vocabulary in every surface', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'bytes-vocabulary-'));
  const cli = path.join(root, 'scripts/vocabulary-guard.mjs');
  const run = () => spawnSync(process.execPath, [cli, fixture], { encoding: 'utf8' });
  try {
    writeFileSync(path.join(fixture, 'README.md'), 'A bytes column.');
    assert.equal(run().status, 0);
    for (const file of ['README.md', 'src/api.ts', 'dist/index.d.ts', 'sample/app.js', 'test/data.json', 'create-arkiv-sync/template/start.ts', 'CHANGELOG.md']) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), 'Pay' + 'LoAd');
      const result = run();
      assert.equal(result.status, 1, file + ': injected term must fail');
      assert.match(result.stderr, /use binary data or a bytes column/);
      writeFileSync(path.join(fixture, file), 'Binary data');
      assert.equal(run().status, 0);
    }
  } finally { rmSync(fixture, { recursive: true }); }
});

// Exceptions must never authorize source prose or new generated variants.
test('third-party exceptions cannot escape their exact generated scope', () => {
  const list = JSON.parse(readFileSync(path.join(root, 'vocabulary-exceptions.json'), 'utf8'));
  for (const entry of list) {
    assert.ok(violations('sample/src/injected.ts', entry.literal).length);
    assert.ok(violations('dist/index.js', entry.literal).length);
    assert.ok(violations(entry.paths[0].slice(0,-2)+'mutation.js', 'new '+('pay'+'load')+' variant').length);
  }
});
test('temporary waiver rejects the same term elsewhere and altered blobs', () => {
  const list = JSON.parse(readFileSync(path.join(root, 'vocabulary-waivers.json'), 'utf8'));
  for (const entry of list) {
    assert.ok(violations('sample/src/another.ts', entry.literal).length);
    const original = readFileSync(path.join(root,entry.file),'utf8');
    assert.ok(violations(entry.file, original+'\n// '+('pay'+'load')).length);
  }
});

test('every source-map string field rejects an unlisted term through the CLI', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'bytes-map-mutation-'));
  const marker = 'pay' + 'load_UNLISTED';
  const file = path.join(fixture, 'dist/audit-injection.js.map');
  mkdirSync(path.dirname(file), { recursive: true });
  const variants = [
    { names: [marker] }, { sources: [marker] }, { file: marker }, { sourceRoot: marker },
    { sources: ['input.ts'], sourcesContent: [marker] }, { extension: { nested: [marker] } },
    { [marker]: 'safe' },
  ];
  try {
    for (const variant of variants) {
      writeFileSync(file, JSON.stringify({ version: 3, sources: [], sourcesContent: [], names: [], mappings: '', ...variant }));
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/vocabulary-guard.mjs'), fixture], { encoding: 'utf8' });
      assert.equal(result.status, 1, JSON.stringify(variant));
      assert.match(result.stderr, /use binary data or a bytes column/);
    }
    writeFileSync(file, JSON.stringify({ version: 3, sources: [], sourcesContent: [], names: ['safe'], mappings: '' }));
    assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/vocabulary-guard.mjs'), fixture]).status, 0);
    console.log(JSON.stringify({ sourceMapMutation: true, stringFields: variants.length, rejected: true }));
  } finally { rmSync(fixture, { recursive: true }); }
});
test('dated historical allowances require exact file and content hash', () => {
  const entries = JSON.parse(readFileSync(path.join(root, 'vocabulary-history.json'), 'utf8'));
  for (const entry of entries) {
    const original = readFileSync(path.join(root, entry.file), 'utf8');
    assert.deepEqual(violations(entry.file, original), []);
    assert.ok(violations('docs/unlisted-history.md', original).length);
    assert.ok(violations(entry.file, original + '\n' + ('pay' + 'load')).length);
  }
});
