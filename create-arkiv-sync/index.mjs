#!/usr/bin/env node
/**
 * create-arkiv-sync — scaffold a chain→Arkiv indexer.
 *
 *   npm create arkiv-sync@latest my-indexer
 *   # or:  node index.mjs <dir> [--local <path-to-arkiv-sync-tgz-or-dir>] [--install]
 *
 * Copies the template, names the project, and (optionally) installs. `--local` points the
 * arkiv-sync dependency at a local tarball/dir (used to test an unpublished build).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(__dirname, 'template')

function parseArgs(argv) {
  const out = { target: null, local: null, install: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--local') out.local = argv[++i]
    else if (a === '--install') out.install = true
    else if (!out.target) out.target = a
  }
  return out
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    // npm strips a literal .gitignore from published packages, so the template ships _gitignore.
    const name = entry.name === '_gitignore' ? '.gitignore' : entry.name
    const s = path.join(src, entry.name)
    const d = path.join(dst, name)
    if (entry.isDirectory()) await copyDir(s, d)
    else await fs.copyFile(s, d)
  }
}

async function main() {
  const { target, local, install } = parseArgs(process.argv.slice(2))
  const dirName = target || 'my-arkiv-sync'
  const dest = path.resolve(process.cwd(), dirName)

  // Refuse to clobber a non-empty directory.
  try {
    const existing = await fs.readdir(dest)
    if (existing.length) {
      console.error(`✗ ${dirName} already exists and is not empty.`)
      process.exit(1)
    }
  } catch {
    /* doesn't exist — good */
  }

  await copyDir(TEMPLATE, dest)

  // Patch package.json: name + optional local dependency.
  const pkgPath = path.join(dest, 'package.json')
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  pkg.name = path.basename(dest).replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'my-arkiv-sync'
  if (local) pkg.dependencies['arkiv-sync'] = `file:${path.resolve(local)}`
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  if (install) {
    console.log('Installing dependencies…')
    execSync('npm install --no-audit --no-fund', { cwd: dest, stdio: 'inherit' })
  }

  console.log(`\n✓ Created ${dirName}\n`)
  console.log('Next steps:')
  console.log(`  cd ${dirName}`)
  if (!install) console.log('  npm install')
  console.log('  cp .env.example .env        # add a funded Braga testnet PRIVATE_KEY')
  console.log('                              # faucet: https://braga.hoodi.arkiv.network/faucet/')
  console.log('  npm run verify              # bounded end-to-end check (Sepolia → Arkiv → query)')
  console.log('  npm start                   # start indexing 24/7')
  console.log('\nEdit arkiv.config.ts to point at your own contract + events.\n')
}

main().catch((err) => {
  console.error(`✗ ${err?.message ?? err}`)
  process.exit(1)
})
