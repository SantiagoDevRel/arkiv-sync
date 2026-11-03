import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Capture every checkout entry, including ignored outputs, dependencies and Git bytes. */
export function snapshotCheckout(root) {
  const entries = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix + name;
      const stat = fs.lstatSync(absolute);
      const identity = { file: relative, mode: stat.mode };
      if (stat.isSymbolicLink()) entries.push({ ...identity, type: 'link', target: fs.readlinkSync(absolute) });
      else if (stat.isDirectory()) { entries.push({ ...identity, type: 'directory' }); visit(absolute, relative + '/'); }
      else if (stat.isFile()) entries.push({ ...identity, type: 'file', bytes: stat.size, sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
      else throw new Error(`Unsupported checkout entry: ${relative}`);
    }
  }
  visit(root);
  return entries;
}

export function assertCheckoutUnchanged(root, before) {
  const after = snapshotCheckout(root);
  assert.deepEqual(after, before, 'checkout must remain byte-identical, including ignored files and dependencies');
  return { checkoutUnchanged: true, entries: before.length };
}

/** Exclusive external output ownership: never overwrite an existing directory or file. */
export function createOutputDirectory(checkout, requested, fallback) {
  if (!requested) { fs.mkdirSync(fallback); return fallback; }
  const destination = path.resolve(requested);
  const parent = fs.realpathSync(path.dirname(destination));
  const canonical = path.join(parent, path.basename(destination));
  const relative = path.relative(fs.realpathSync(checkout), canonical);
  const inside = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  assert(!inside, '--out must be outside the checkout');
  fs.mkdirSync(canonical); // EEXIST is intentional, including empty directories and symlinks.
  return canonical;
}

/** Run mutating tools only in an owned, independent temporary copy. */
export function withIsolatedCheckout(callback, { checkout = process.cwd(), prefix = 'sdk-check-', retain = false } = {}) {
  const root = fs.realpathSync(checkout);
  const before = snapshotCheckout(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const copy = path.join(temporary, 'checkout');
  const excluded = new Set(['.git', 'node_modules', '.cache', '.next', '.vercel']);
  try {
    fs.cpSync(root, copy, { recursive: true, filter: source => {
      const relative = path.relative(root, source);
      const parts = relative.split(path.sep);
      if (parts.some(part => excluded.has(part) || part.startsWith('.env') || part === '.arkiv-sync')) return false;
      if (parts.some((part, index) => part === 'artifacts' && /journal/i.test(parts[index + 1] ?? ''))) return false;
      if (parts.some((part, index) => part === '.candidate-artifacts' && (parts[index + 1] === 'live-sdk101-runs' || /^live-sdk101(?:\.reconciled)?\.json$/.test(parts[index + 1] ?? '')))) return false;
      assert(!fs.lstatSync(source).isSymbolicLink(), `Included source must not link back to the checkout: ${relative}`);
      return true;
    } });
    return callback({ root: copy, temporary, original: root });
  } finally {
    try {
      const result = assertCheckoutUnchanged(root, before);
      console.log(JSON.stringify({ status: 'PASS', ...result }));
    } finally {
      // Only this invocation's mkdtemp directory is owned by this helper.
      if (retain) fs.rmSync(copy, { recursive: true, force: true });
      else fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
