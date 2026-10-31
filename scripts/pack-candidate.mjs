import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const artifacts = path.join(root, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const run = (command, args, cwd = root, env = process.env) => execFileSync(command, args, { cwd, env, stdio: 'inherit' })
run('npm', ['pack', '--ignore-scripts', '--pack-destination', artifacts])
run('npm', ['pack', '--ignore-scripts', '--pack-destination', artifacts], path.join(root, 'create-arkiv-sync'))
const runtime = path.join(artifacts, 'arkiv-sync-1.0.0.tgz')
const scaffolder = path.join(artifacts, 'create-arkiv-sync-1.0.0.tgz')
const clean = mkdtempSync(path.join(process.env.TMPDIR, 'sync-consumer-'))
writeFileSync(path.join(clean, 'package.json'), JSON.stringify({ name: 'sync-packed-consumer', private: true, type: 'module' }))
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', scaffolder], clean)
const target = path.join(clean, 'scaffold')
const cli = path.join(clean, 'node_modules/create-arkiv-sync/index.mjs')
run(process.execPath, [cli, target, '--local', runtime, '--install'], clean)
run('npm', ['run', 'typecheck'], target)
run(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { createArkivReader, createIndexer, WriteOperation, RABDI_CHAIN_ID } from 'arkiv-sync';
  assert.equal(RABDI_CHAIN_ID,7794095);
  assert.equal(typeof createIndexer,'function'); assert.equal(typeof WriteOperation,'function');
  const saved = process.env.ARKIV_ACCESS_KEY; delete process.env.ARKIV_ACCESS_KEY;
  assert.throws(()=>createArkivReader(),/access key/i);
  if(saved) process.env.ARKIV_ACCESS_KEY=saved;
  console.log('PASS clean packed consumer imports and fail-closed missing access key');
`], target)
const readme = readFileSync(path.join(target, 'README.md'))
const refused = spawnSync(process.execPath, [cli, target], { cwd: clean, encoding: 'utf8' })
assert.equal(refused.status, 1)
assert.deepEqual(readFileSync(path.join(target, 'README.md')), readme)
const live = process.argv.includes('--live')
if (live) {
  run(process.execPath, ['scripts/live-rabdi.mjs'])
  run(process.execPath, ['scripts/seed-rabdi.mjs'])
  run(process.execPath, ['scripts/seed-rabdi.mjs'])
  const env = { ...process.env, PRIVATE_KEY: process.env.TEST_SYNC_PRIVATE_KEY, ARKIV_ACCESS_KEY: process.env.ARKIV_ACCESS_KEY_A }
  run('npm', ['run', 'verify'], target, env)
}
mkdirSync(path.join(root, 'web-demo/vendor'), { recursive: true })
copyFileSync(runtime, path.join(root, 'web-demo/vendor/arkiv-sync-1.0.0.tgz'))
// A mutable file dependency must be locked in a clean directory: npm can otherwise reuse
// the previous archive's integrity even after the archive has changed at the same path.
const web = path.join(clean, 'web')
mkdirSync(path.join(web, 'vendor'), { recursive: true })
copyFileSync(path.join(root, 'web-demo/package.json'), path.join(web, 'package.json'))
copyFileSync(runtime, path.join(web, 'vendor/arkiv-sync-1.0.0.tgz'))
run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], web)
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], web)
const webLock = JSON.parse(readFileSync(path.join(web, 'package-lock.json'), 'utf8'))
assert.equal(webLock.packages['node_modules/arkiv-sync'].integrity,
  'sha512-' + createHash('sha512').update(readFileSync(runtime)).digest('base64'))
copyFileSync(path.join(web, 'package-lock.json'), path.join(root, 'web-demo/package-lock.json'))
copyFileSync(path.join(root, 'web-demo/build.mjs'), path.join(web, 'build.mjs'))
copyFileSync(path.join(root, 'web-demo/index.html'), path.join(web, 'index.html'))
run('npm', ['run', 'build'], web)
assert.deepEqual(readFileSync(path.join(web, 'public/index.html')), readFileSync(path.join(web, 'index.html')))
mkdirSync(path.join(web, 'api'))
for (const name of ['query', 'run', 'config', 'chains', 'abi']) copyFileSync(path.join(root, `web-demo/api/${name}.js`), path.join(web, `api/${name}.js`))
const { default: queryHandler } = await import(new URL('file://' + path.join(web, 'api/query.js')))
const { default: runHandler } = await import(new URL('file://' + path.join(web, 'api/run.js')))
let calls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { calls++; throw new Error('Network must not be used by rejected requests') }
try {
  const response = () => ({ statusCode: 200, body: '', setHeader() {}, writeHead() {}, write(data) { this.body += data }, end(data = '') { this.body += data } })
  const invalid = response()
  await queryHandler({ url: '/api/query?contract=invalid&chain=sepolia' }, invalid)
  assert.equal(invalid.statusCode, 400)
  assert.equal(JSON.parse(invalid.body).ok, false)
  const saved = process.env.ENABLE_DEMO_WRITES
  delete process.env.ENABLE_DEMO_WRITES
  const disabled = response()
  await runHandler({ url: '/api/run?contract=invalid' }, disabled)
  assert.match(disabled.body, /read-only/)
  if (saved !== undefined) process.env.ENABLE_DEMO_WRITES = saved
  assert.equal(calls, 0)
} finally { globalThis.fetch = originalFetch }
const hashes = Object.fromEntries([runtime, scaffolder].map(file => [path.basename(file), createHash('sha256').update(readFileSync(file)).digest('hex')]))
writeFileSync(path.join(artifacts, live ? 'packed-live.json' : 'packed-offline.json'), JSON.stringify({ status: 'PASS', node: process.version,
  hashes, scaffoldTypecheck: true, cleanConsumer: true, nonemptyTargetRefused: true, live }, null, 2) + '\n')
console.log(JSON.stringify({ status: 'PASS', hashes, scaffoldTypecheck: true, cleanConsumer: true, live }))
