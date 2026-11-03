import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withIsolatedCheckout } from './isolated-checkout.mjs';

/** Refuse the original checkout before invoking the mutating helper. */
export function runPreparedMutation(directory, { original, temporary, run = execFileSync }) {
  const target = fs.realpathSync(directory);
  assert.notEqual(target, fs.realpathSync(original), 'mutation must never target the original checkout');
  assert.equal(target, path.join(fs.realpathSync(temporary), 'checkout'), 'mutation must target its prepared temporary copy');
  run(process.execPath, ['scripts/vocabulary-build-mutation.mjs'], { cwd: target, stdio: 'inherit' });
}

/** Prepare dependencies and run the unchanged source/build mutation in a fresh copy. */
export function checkVocabularyBuild({ checkout = process.cwd(), run = execFileSync } = {}) {
  return withIsolatedCheckout(({ root, temporary, original }) => {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    const execute = (command, args, directory = root) => run(command, args, {
      cwd: directory, stdio: 'inherit', env: { ...process.env, CI: 'true' },
    });
    if (name === 'arkiv-graph-monorepo') {
      execute('pnpm', ['install', '--frozen-lockfile']);
    } else {
      execute('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      execute('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(root, name === 'arkiv-sync' ? 'web-demo' : 'sample'));
    }
    runPreparedMutation(root, { original, temporary, run });
  }, { checkout, prefix: 'vocabulary-build-check-' });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) checkVocabularyBuild();
