#!/usr/bin/env bun
//
// Fetches the raw MapLibre map assets into dist/:
//   - dist/basemap-<date>.pmtiles  z0-z7 global extract of the Protomaps daily planet build (~270MB,
//                                  kept under Cloudflare's 512MiB cache cap — see MAXZOOM in config.ts)
//   - dist/fonts/                  Noto Sans glyph PBFs required by protomaps-themes-base labels
//
// Usage:    bun run fetch
// Re-fetch: delete dist/basemap-*.pmtiles and/or dist/fonts, then run again.
// Overrides:
//   PROTOMAPS_BUILD_DATE=YYYYMMDD   fetch a different Protomaps build (update BASEMAP_BUILD_DATE
//                                   in src/config.ts — and the app pin — to actually switch over)
//   PROTOMAPS_ASSETS_REF=<ref>      pin a different protomaps/basemaps-assets ref for the fonts

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { BASEMAP_BUILD_DATE, DIST, MAXZOOM } from './config'

const BUILD_DATE = process.env.PROTOMAPS_BUILD_DATE ?? BASEMAP_BUILD_DATE
const FONTS_REF = process.env.PROTOMAPS_ASSETS_REF ?? 'main'

const fetchBasemap = async () => {
  const dest = join(DIST, `basemap-${BUILD_DATE}.pmtiles`)
  if (BUILD_DATE !== BASEMAP_BUILD_DATE) {
    console.log(`note: fetching build ${BUILD_DATE}; the pinned build is ${BASEMAP_BUILD_DATE} (src/config.ts).`)
  }
  if (existsSync(dest)) {
    console.log(`Basemap already present: ${dest}. Delete it to re-fetch.`)
    return
  }

  if (!Bun.which('pmtiles')) {
    console.error("error: the 'pmtiles' CLI (go-pmtiles) is required but not installed.")
    console.error('Install it, then re-run `bun run fetch`:')
    console.error('  macOS:  brew install pmtiles')
    console.error('  other:  https://github.com/protomaps/go-pmtiles/releases')
    process.exit(1)
  }

  // `pmtiles extract` pulls only the low-zoom tiles over HTTP range requests — it does NOT
  // download the full ~120GB planet.
  const source = `https://build.protomaps.com/${BUILD_DATE}.pmtiles`
  console.log(`Extracting z0-${MAXZOOM} basemap from ${source}`)
  console.log('(HTTP range requests — only low-zoom tiles are downloaded, not the full planet)')
  await mkdir(DIST, { recursive: true })
  await $`pmtiles extract ${source} ${dest} --maxzoom=${MAXZOOM}`
  console.log(`Done: ${dest}`)
}

const fetchFonts = async () => {
  const dest = join(DIST, 'fonts')
  if (existsSync(dest)) {
    console.log(`Glyph fonts already present: ${dest}. Delete it to re-fetch.`)
    return
  }

  // protomaps-themes-base labels reference the Noto Sans stacks shipped by protomaps/basemaps-assets.
  const tarball = `https://github.com/protomaps/basemaps-assets/archive/refs/heads/${FONTS_REF}.tar.gz`
  console.log(`Fetching glyph fonts from protomaps/basemaps-assets (${FONTS_REF})`)

  const res = await fetch(tarball)
  if (!res.ok) {
    console.error(`error: failed to download fonts (${res.status} ${res.statusText}) from ${tarball}`)
    process.exit(1)
  }

  const tmp = await mkdtemp(join(tmpdir(), 'pug-map-fonts-'))
  try {
    const archive = join(tmp, 'assets.tar.gz')
    await Bun.write(archive, res)
    await mkdir(dest, { recursive: true })
    // Extract only the fonts/ subtree, stripping the `basemaps-assets-<ref>/fonts/` prefix so the
    // font-stack directories land directly under dist/fonts. (Avoids a cross-device move out of /tmp.)
    await $`tar -xzf ${archive} --strip-components=2 -C ${dest} basemaps-assets-${FONTS_REF}/fonts`
    console.log(`Done: ${dest}`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

await fetchBasemap()
await fetchFonts()
