/**
 * Build the publishable package: ESM JS via esbuild (tsc OOMs on viem's types when bundling),
 * plus .d.ts type declarations via tsc --emitDeclarationOnly. Runtime deps stay external so they
 * resolve from the consumer's node_modules.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
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

// Type declarations are part of the public contract; fail the build if they cannot be emitted.
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
console.log('✓ types emitted (dist/index.d.ts)')

console.log('✓ build complete: dist/index.js, dist/bin/cli.js')
