import { copyFileSync, mkdirSync } from 'node:fs'
// Only this generated directory is public. The candidate tarball, dependency metadata
// and server sources are build inputs, never static downloads.
mkdirSync('public', { recursive: true })
copyFileSync('index.html', 'public/index.html')
