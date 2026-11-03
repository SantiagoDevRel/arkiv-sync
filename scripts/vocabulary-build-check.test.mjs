import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkVocabularyBuild, runPreparedMutation } from './vocabulary-build-check.mjs';
import { snapshotCheckout, assertCheckoutUnchanged } from './isolated-checkout.mjs';

function fixture(callback) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-build-test-'));
  const checkout = path.join(temporary, 'original');
  fs.mkdirSync(checkout);
  for (const file of ['package.json', 'src/index.ts', 'dist/index.js', 'node_modules/example.js', '.git/HEAD', 'sample/package.json']) {
    const target = path.join(checkout, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.endsWith('package.json') ? '{"name":"postgres-to-entity"}' : 'original bytes');
  }
  try { callback({ checkout, temporary }); }
  finally { fs.rmSync(temporary, { recursive: true }); }
}

test('dependency preparation and source/build mutations run only in the temporary copy', () => fixture(({ checkout }) => {
  const before = snapshotCheckout(checkout);
  const calls = [];
  let copy;
  checkVocabularyBuild({ checkout, run: (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    assert.notEqual(options.cwd, checkout);
    if (args.includes('scripts/vocabulary-build-mutation.mjs')) {
      copy = options.cwd;
      fs.writeFileSync(path.join(copy, 'src/index.ts'), 'mutated source');
      fs.writeFileSync(path.join(copy, 'dist/index.js'), 'mutated generated output');
    }
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).cwd, copy);
  assert(!fs.existsSync(copy), 'owned temporary copy is cleaned');
  assertCheckoutUnchanged(checkout, before);
}));

test('pointing the helper at the original checkout fails before any command runs', () => fixture(({ checkout, temporary }) => {
  const before = snapshotCheckout(checkout);
  let calls = 0;
  const run = () => { calls++; };
  assert.throws(() => runPreparedMutation(checkout, { original: checkout, temporary, run }), /original checkout/);
  fs.symlinkSync(checkout, path.join(temporary, 'alias'));
  assert.throws(() => runPreparedMutation(path.join(temporary, 'alias'), { original: checkout, temporary, run }), /original checkout/);
  assert.equal(calls, 0);
  assertCheckoutUnchanged(checkout, before);
  console.log(JSON.stringify({ originalTargetRed: true, realpathAliasRed: true, commandsBeforeRefusal: calls }));
}));

test('a failing mutation still asserts checkout identity and cleans its copy', () => fixture(({ checkout }) => {
  const before = snapshotCheckout(checkout);
  let copy;
  assert.throws(() => checkVocabularyBuild({ checkout, run: (_command, args, options) => {
    if (!args.includes('scripts/vocabulary-build-mutation.mjs')) return;
    copy = options.cwd;
    fs.writeFileSync(path.join(copy, 'src/index.ts'), 'failed mutation in copy');
    throw new Error('intentional mutation failure');
  } }), /intentional mutation failure/);
  assert(!fs.existsSync(copy));
  assertCheckoutUnchanged(checkout, before);
  assert.throws(() => checkVocabularyBuild({ checkout, run: (_command, args) => {
    if (args.includes('scripts/vocabulary-build-mutation.mjs')) {
      fs.writeFileSync(path.join(checkout, 'src/index.ts'), 'unexpected original mutation');
      throw new Error('intentional mutation failure');
    }
  } }), /byte-identical/);
}));

function assertIsolatedEntryPoint(text) {
  const commands = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert(commands.includes('node scripts/vocabulary-build-check.mjs'), 'verification must invoke the isolation wrapper');
  assert(!commands.some(line => /\bnode\s+scripts\/vocabulary-build-mutation\.mjs\b/.test(line)), 'verification must not invoke the mutation directly');
}

test('the verification entry point cannot bypass mutation isolation', () => {
  const text = fs.readFileSync(new URL('./verify-sdk101.sh', import.meta.url), 'utf8');
  assertIsolatedEntryPoint(text);
  const old = text.replace('node scripts/vocabulary-build-check.mjs', 'node scripts/vocabulary-build-mutation.mjs');
  assert.throws(() => assertIsolatedEntryPoint(old), /isolation wrapper|mutation directly/);
  console.log(JSON.stringify({ directEntryPointRed: true, isolatedEntryPointGreen: true }));
});
