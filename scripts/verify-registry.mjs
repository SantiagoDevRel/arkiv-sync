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
  'arkiv-sync': '5709c784a220890a74a5ad26763dd476c2c83848ff8e589a0ea8134bce27b5a0',
  'create-arkiv-sync': '4ba9b855ee78be0bde15ff035f73dfae443928345228ea7a685aff3124c07c74',
}
const versions = {
  'arkiv-sync': json(path.join(root, 'package.json')).version,
  'create-arkiv-sync': json(path.join(root, 'create-arkiv-sync/package.json')).version,
}
const archives = {}
for (const [name, sha256] of Object.entries(expected)) {
  run('npm', ['pack', `${name}@${versions[name]}`, '--ignore-scripts', '--pack-destination', clean])
  const archive = path.join(clean, `${name}-${versions[name]}.tgz`)
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), sha256)
  archives[name] = archive
}
writeFileSync(path.join(clean, 'package.json'), JSON.stringify({ name: 'sync-registry-certification', private: true, type: 'module' }))
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archives['create-arkiv-sync']])
const target = path.join(clean, 'scaffold')
run(process.execPath, [path.join(clean, 'node_modules/create-arkiv-sync/index.mjs'), target, '--install'])
const consumer = json(path.join(target, 'package.json'))
assert.equal(consumer.dependencies['arkiv-sync'], versions['arkiv-sync'])
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
assert.equal(json(path.join(web, 'package.json')).dependencies['arkiv-sync'], versions['arkiv-sync'])
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
