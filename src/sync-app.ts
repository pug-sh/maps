#!/usr/bin/env bun
//
// Wires dist/ into the dashboard app's public/ for local development, so the app's unset
// VITE_MAP_ASSETS_URL fallback (its own origin) serves the same artifacts the CDN would.
// The basemap and fonts are symlinked (the basemap is ~500MB — no point copying); the small
// POV JSONs are copied. Everything it creates is gitignored in the app.
//
// Usage: bun run sync:app [path-to-app]   (default: ../app)

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { BASEMAP_FILENAME, DIST, POV_DIR, ROOT } from './config'

const appDir = resolve(process.argv[2] ?? join(ROOT, '..', 'app'))
const publicDir = join(appDir, 'public')
if (!existsSync(publicDir)) {
  console.error(`error: ${publicDir} not found — pass the app repo path, e.g. \`bun run sync:app ../app\``)
  process.exit(1)
}

const link = (name: string) => {
  const source = join(DIST, name)
  const dest = join(publicDir, name)
  if (!existsSync(source)) {
    console.error(`error: ${source} missing — run \`bun run build\` first.`)
    process.exit(1)
  }
  rmSync(dest, { recursive: true, force: true })
  symlinkSync(relative(dirname(dest), source), dest)
  console.log(`linked ${dest} -> ${source}`)
}

link(BASEMAP_FILENAME)
link('fonts')

const povSource = join(DIST, POV_DIR)
const povDest = join(publicDir, POV_DIR)
if (!existsSync(povSource)) {
  console.error(`error: ${povSource} missing — run \`bun run generate\` first.`)
  process.exit(1)
}
rmSync(join(publicDir, 'pov'), { recursive: true, force: true })
mkdirSync(dirname(povDest), { recursive: true })
cpSync(povSource, povDest, { recursive: true })
console.log(`copied ${povSource} -> ${povDest}`)
