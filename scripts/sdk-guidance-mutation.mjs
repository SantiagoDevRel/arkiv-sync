import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkTree } from './sdk-guidance-guard.mjs';

assert.deepEqual(checkTree('.'), [], 'current tree must be green');
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sdk-guidance-mutation-'));
const version = ['1', '0', '0'].join('.');
const cases = [
  ['README.md', `Install @arkiv-network/sdk@${version}`],
  ['template/package.json', JSON.stringify({ dependencies: { '@arkiv-network/sdk': version } })],
  ['docs/current.md', `Targets SDK **${version}**.`],
  ...['file', 'sources', 'names', 'sourcesContent'].map(field => ['dist/output.js.map', JSON.stringify({ version: 3, [field]: field === 'file' ? `SDK ${version}` : [`SDK ${version}`] })]),
];
try {
  for (const [file, body] of cases) {
    const target = path.join(scratch, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    assert.ok(checkTree(scratch).length > 0, `must reject ${file}`);
    fs.unlinkSync(target);
  }
  fs.writeFileSync(path.join(scratch, 'README.md'), 'SDK ^' + version + ', verified with 1.0.1');
  assert.deepEqual(checkTree(scratch), [], 'compatible ranges must remain green');
} finally { fs.rmSync(scratch, { recursive: true }); }
console.log(JSON.stringify({ status: 'PASS', guidanceMutations: cases.length, sourceMapFields: 4, compatibleRangeAccepted: true }));
