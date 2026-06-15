/**
 * Build the publishable package: ESM JS via esbuild (tsc OOMs on viem's types when bundling),
 * plus .d.ts type declarations via tsc --emitDeclarationOnly. Runtime deps stay external so they
 * resolve from the consumer's node_modules.
 */
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const external = ['@arkiv-network/sdk', '@arkiv-network/sdk/*', 'viem', 'viem/*', 'dotenv']

rmSync('dist', { recursive: true, force: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  sourcemap: true,
  logLevel: 'info',
}

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' })
await build({
  ...common,
  entryPoints: ['src/bin/cli.ts'],
  outfile: 'dist/bin/cli.js',
  banner: { js: '#!/usr/bin/env node' },
})

// Type declarations → dist/index.d.ts (rootDir=src). Best-effort: runtime works without them.
try {
  execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' })
  console.log('✓ types emitted (dist/index.d.ts)')
} catch {
  console.warn('! type emit failed — shipping JS without .d.ts (runtime unaffected)')
}

console.log('✓ build complete: dist/index.js, dist/bin/cli.js')
