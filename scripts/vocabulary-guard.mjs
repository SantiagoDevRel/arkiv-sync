import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const term = 'pay' + 'load';
const forbidden = new RegExp(term, 'gi');
const ignored = new Set(['.git', 'node_modules', '.vercel', '.cache']);
const rules = new Map([]);


const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const exceptions = JSON.parse(readFileSync(path.join(repoRoot, 'vocabulary-exceptions.json'), 'utf8'));
const history = JSON.parse(readFileSync(path.join(repoRoot, 'vocabulary-history.json'), 'utf8'));
const waivers = JSON.parse(readFileSync(path.join(repoRoot, 'vocabulary-waivers.json'), 'utf8'));
function generated(file) { return ['sample/dist/assets/', 'apps/example/.next/static/', 'apps/example/.next/server/'].some(prefix => file.startsWith(prefix)); }
function globMatch(file, glob) { return glob.endsWith('/**') && file.startsWith(glob.slice(0,-2)); }
for (const entry of exceptions) {
  if (!entry.literal || !entry.origin || !entry.reason || !Array.isArray(entry.paths) || !entry.paths.length || entry.paths.some(p => !['sample/dist/assets/**','apps/example/.next/static/**','apps/example/.next/server/**'].includes(p))) throw new Error('Invalid generated exception');
}
function waive(file, text) {
  if (!waivers.some(w => w.file === file)) return text;
  const hash = createHash('sha256').update(text).digest('hex');
  const blob = createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
  return text.split(/\r?\n/).map((line,i) => waivers.some(w => w.file===file && w.line===i+1 && w.sha256===hash && w.blobSha1===blob && w.literal===line) ? '' : line).join('\n');
}

/** Only exact compatibility statements are exempt; prose on the same line is checked. */
export function violations(file, text, parseMap = true) {
  const archived = history.find(entry => entry.file === file && entry.sha256 === createHash('sha256').update(text).digest('hex'));
  if (archived) text = text.split(/\r?\n/).map(line => archived.lines.includes(line) ? '' : line).join('\n');
  text = waive(file, text);
  if (generated(file)) {
    const spans=[];
    for (const entry of exceptions) if(entry.paths.some(glob => globMatch(file,glob))) {
      let at=text.indexOf(entry.literal);
      while(at!==-1){spans.push([at,at+entry.literal.length]);at=text.indexOf(entry.literal,at+1);}
    }
    const original=text;
    // Offsets are UTF-16 code units, matching indexOf and slice.
    const masked=text.split('');
    for(const [start,end] of spans) for(let i=start;i<end;i++) if(original[i]!=='\n') masked[i]=' ';
    text=masked.join('');
  }
  if (parseMap && file.endsWith('.map')) {
    const map = JSON.parse(text);
    function inspect(value, fields = []) {
      if (typeof value === 'string') {
        const index = fields.length === 2 && fields[0] === 'sourcesContent' ? Number(fields[1]) : -1;
        const source = index >= 0 ? map.sources?.[index] : undefined;
        return typeof source === 'string'
          ? violations(path.posix.normalize(path.posix.join(path.posix.dirname(file), source)), value, false)
          : violations(file, value, false);
      }
      if (Array.isArray(value)) return value.flatMap((entry, index) => inspect(entry, [...fields, String(index)]));
      if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => [...violations(file, key, false), ...inspect(entry, [...fields, key])]);
      return [];
    }
    return inspect(map);
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
      if (ignored.has(entry.name) || entry.name.endsWith('.tsbuildinfo') || /(?:^|\/)\.next\/cache\//.test(prefix + entry.name + '/') || prefix.endsWith('.next/') && !['static','server'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      if (forbidden.test(entry.name)) findings.push(`${relative}: rename file`);
      forbidden.lastIndex = 0;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${relative}`);
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative + '/');
      else {
        const data = readFileSync(path.join(dir, entry.name));
        if (data.includes(0)) continue;
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { continue; }
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
