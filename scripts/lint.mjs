import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Script } from 'node:vm'
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === 'node_modules' || e.name === '.vercel' ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
for (const file of [...walk('scripts'), ...walk('web-demo/api'), 'web-demo/build.mjs', 'build.mjs', 'create-arkiv-sync/index.mjs']) {
  if (/.(m?js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}
const current = ['README.md', 'AGENTS.md', 'CHANGELOG.md', 'skill/SKILL.md', 'skill/skill-lock.json',
  ...walk('examples'), ...walk('create-arkiv-sync/template'), 'web-demo/README.md', 'web-demo/index.html']
const forbidden = /Tiramisu|Braga|7738577|60138453102|TTL|BTL|time-to-live|records|on Ethereum|payload|permanent/i
for (const file of current) {
  if (forbidden.test(readFileSync(file, 'utf8'))) throw new Error(`Outdated current guidance or vocabulary: ${file}`)
}
const html = readFileSync('web-demo/index.html', 'utf8')
for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(script)
console.log('PASS JavaScript syntax and current public vocabulary')
