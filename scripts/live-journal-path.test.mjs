import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectLiveJournal } from './live-journal-path.mjs';

function fixture(callback) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-journal-path-'));
  try { callback(checkout); } finally { fs.rmSync(checkout, { recursive: true }); }
}
test('new live runs keep journals under ignored pending-state storage', () => fixture(checkout => {
  assert.equal(selectLiveJournal({ checkout, args: [] }), path.join(checkout, '.arkiv-sync/sdk101-roundtrip-journal'));
  assert.equal(selectLiveJournal({ checkout, args: ['--journal', '../explicit-journal'] }), path.resolve(checkout, '../explicit-journal'));
}));
test('existing legacy journals are reported and cannot be bypassed or moved', () => fixture(checkout => {
  const legacy = path.join(checkout, 'artifacts/sdk101-roundtrip-journal');
  fs.mkdirSync(legacy, { recursive: true });
  const file = path.join(legacy, 'pending.json'); fs.writeFileSync(file, '{"state":"pending"}');
  const bytes = fs.readFileSync(file);
  for (const args of [[], ['--journal', 'another-journal']]) assert.throws(() => selectLiveJournal({ checkout, args }), error => error.message.includes(legacy));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(selectLiveJournal({ checkout, args: ['--journal', legacy] }), legacy);
  assert(!fs.existsSync(path.join(checkout, '.arkiv-sync')));
}));
test('journal arguments fail closed when incomplete or ambiguous', () => fixture(checkout => {
  for (const args of [['--journal'], ['--journal', ''], ['--other', 'path'], ['--journal', 'one', '--journal', 'two']]) assert.throws(() => selectLiveJournal({ checkout, args }), /Usage:/);
}));
test('live sink uses the selected durable journal without changing recovery', () => {
  const source = fs.readFileSync(new URL('./live-sdk101.mjs', import.meta.url), 'utf8');
  assert.match(source, /selectLiveJournal\(/, 'live script must select the durable journal');
  assert.match(source, /journalDirectory\s*[,}]/);
  assert.doesNotMatch(source, /journalDirectory:\s*['"]artifacts\//);
});
