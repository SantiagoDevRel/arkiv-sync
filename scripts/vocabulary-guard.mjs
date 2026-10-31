import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const term = 'pay' + 'load';
const forbidden = new RegExp(term, 'gi');
const ignored = new Set(['.git', 'node_modules', '.next', '.vercel', '.cache']);
const rules = new Map([]);

/** Only exact compatibility statements are exempt; prose on the same line is checked. */
export function violations(file, text) {
  if (file.endsWith('.map')) {
    const map = JSON.parse(text);
    return (map.sourcesContent ?? []).flatMap((source, i) => source == null ? [] :
      violations(path.posix.normalize(path.posix.join(path.posix.dirname(file), map.sources[i])), source));
  }
  const allowed = rules.get(file) ?? (file.includes('/dist/') || file.startsWith('dist/') ? rules.get('@generated') ?? [] : []);
  return text.split(/\r?\n/).flatMap((line, i) => {
    let current = line;
    for (const statement of allowed) {
      if (current.trim() === statement.trim()) current = '';
    }
    return [...current.matchAll(forbidden)].map(() => `${file}:${i + 1}: use binary data or a bytes column`);
  });
}

/** Scan sources, documentation, fixtures, templates and every generated UTF-8 file. */
export function checkTree(root) {
  const findings = [];
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const relative = prefix + entry.name;
      if (forbidden.test(entry.name)) findings.push(`${relative}: rename file`);
      forbidden.lastIndex = 0;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${relative}`);
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative + '/');
      else {
        const data = readFileSync(path.join(dir, entry.name));
        if (data.includes(0)) continue;
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { continue; }
        findings.push(...violations(relative, text));
      }
    }
  }
  visit(root);
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkTree(path.resolve(process.argv[2] ?? '.'));
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log('PASS complete tree vocabulary');
}
