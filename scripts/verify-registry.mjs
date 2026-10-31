import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const clean = mkdtempSync(path.join(process.env.TMPDIR, 'sync-registry-'))
const run = (command, args, cwd = clean) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const expected = {
  'arkiv-sync': '290009ad4718b84ab56456f6b70e78b85ed2533f0c821efc5b3c89aaeec9b5a1',
  'create-arkiv-sync': '7cee87b5232dc58672f21575edb6a80ee072401fb017812dbd5563e29ae6a956',
}
const archives = {}
for (const [name, sha256] of Object.entries(expected)) {
  run('npm', ['pack', `${name}@1.0.0`, '--ignore-scripts', '--pack-destination', clean])
  const archive = path.join(clean, `${name}-1.0.0.tgz`)
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), sha256)
  archives[name] = archive
}
writeFileSync(path.join(clean, 'package.json'), JSON.stringify({ name: 'sync-registry-certification', private: true, type: 'module' }))
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archives['create-arkiv-sync']])
const target = path.join(clean, 'scaffold')
run(process.execPath, [path.join(clean, 'node_modules/create-arkiv-sync/index.mjs'), target, '--install'])
const consumer = json(path.join(target, 'package.json'))
assert.equal(consumer.dependencies['arkiv-sync'], '1.0.0')
assert.equal(consumer.dependencies['@arkiv-network/sdk'], '1.0.0')
assert.deepEqual(json(path.join(root, 'create-arkiv-sync/template/package.json')).dependencies, consumer.dependencies)
const consumerLock = json(path.join(target, 'package-lock.json'))
assert.match(consumerLock.packages['node_modules/arkiv-sync'].resolved, /^https:\/\/registry\.npmjs\.org\//)
run('npm', ['run', 'typecheck'], target)
// The approved template has no npm build script; compile using its installed pinned compiler.
run(process.execPath, [path.join(target, 'node_modules/typescript/bin/tsc'), '--outDir', 'dist'], target)
for (const file of ['start.js', 'verify.js', 'arkiv.config.js']) assert(existsSync(path.join(target, 'dist', file)))
const cli = path.join(target, 'node_modules/arkiv-sync/dist/bin/cli.js')
run(process.execPath, ['--check', cli], target)
assert.match(execFileSync(process.execPath, [cli, '--help'], { cwd: target, encoding: 'utf8' }), /Usage:/)

const web = path.join(clean, 'web')
mkdirSync(web)
copyFileSync(path.join(root, 'web-demo/package.json'), path.join(web, 'package.json'))
assert.equal(json(path.join(web, 'package.json')).dependencies['arkiv-sync'], '1.0.0')
run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], web)
const lock = json(path.join(web, 'package-lock.json'))
assert.match(lock.packages['node_modules/arkiv-sync'].resolved, /^https:\/\/registry\.npmjs\.org\//)
assert.equal(lock.packages['node_modules/arkiv-sync'].integrity,
  'sha512-' + createHash('sha512').update(readFileSync(archives['arkiv-sync'])).digest('base64'))
if (process.argv.includes('--update-lock')) copyFileSync(path.join(web, 'package-lock.json'), path.join(root, 'web-demo/package-lock.json'))
else assert.deepEqual(json(path.join(root, 'web-demo/package-lock.json')), lock)
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], web)
for (const file of ['build.mjs', 'index.html']) copyFileSync(path.join(root, 'web-demo', file), path.join(web, file))
run('npm', ['run', 'build'], web)
assert.deepEqual(readFileSync(path.join(web, 'public/index.html')), readFileSync(path.join(root, 'web-demo/index.html')))
mkdirSync(path.join(root, 'artifacts'), { recursive: true })
const result = { status: 'PASS', node: process.version, registrySha256: expected,
  scaffoldRegistryPins: true, scaffoldTypecheck: true, scaffoldBuild: true,
  packedCliCheck: true, packedCliHelp: true, demoRegistryPin: true, demoBuild: true }
writeFileSync(path.join(root, 'artifacts/registry-verification.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
