import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, 'sdk-guidance-allowlist.json'), 'utf8'));
const old = ['1', '0', '0'].join('\\.');
const patterns = [
  new RegExp('@arkiv-network/sdk@' + old + '(?![\\d.])', 'i'),
  new RegExp('["\']@arkiv-network/sdk["\']\\s*:\\s*["\']' + old + '["\']', 'i'),
  new RegExp('\\bSDK[\\s`*_]*' + old + '(?![\\d.])', 'i'),
  new RegExp('arkiv\\.sdk-verified:\\s*["\']' + old, 'i'),
];
export function violations(file, text) {
  const history = config.history.find(e => e.file === file);
  if (history && createHash('sha256').update(text).digest('hex') === history.sha256) return [];
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!patterns.some(p => p.test(line))) return [];
    if (config.lines.some(e => e.file === file && e.literal === line && e.reason)) return [];
    return [`${file}:${index + 1}: stale exact SDK guidance`];
  });
}
const ignored = new Set(['.git', 'node_modules', '.vercel', '.cache', '.next', 'release-evidence', '.candidate-artifacts', 'artifacts']);
export function checkTree(root, sourcePrefix = '') {
  const findings = [];
  function visit(dir, prefix = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(e.name) || e.name.endsWith('.tsbuildinfo')) continue;
      const file = prefix + e.name;
      if (e.isSymbolicLink()) throw Error(`Unexpected symlink: ${file}`);
      if (e.isDirectory()) visit(path.join(dir, e.name), file + '/');
      else {
        // The reviewed allowlist contains historical citations, never installation guidance.
        if (file === 'scripts/sdk-guidance-allowlist.json') continue;
        const data = fs.readFileSync(path.join(dir, e.name));
        if (data.includes(0)) continue;
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { continue; }
        if (file.endsWith('.map')) {
          const inspect = value => {
            if (typeof value === 'string') findings.push(...violations(file, value));
            else if (Array.isArray(value)) value.forEach(inspect);
            else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { inspect(key); inspect(item); });
          };
          inspect(JSON.parse(text));
        } else findings.push(...violations(file, text));
      }
    }
  }
  visit(root, sourcePrefix);
  return findings;
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? '.');
  let findings;
  if (process.argv.includes('--baseline')) {
    const base = process.argv[process.argv.indexOf('--baseline') + 1];
    findings = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { cwd: root, encoding: 'utf8' }).trim().split('\n')
      .flatMap(file => violations(file, execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })));
  } else findings = checkTree(root);
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log('PASS SDK guidance (historical receipts and compatibility contracts preserved)');
}
