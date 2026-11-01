#!/usr/bin/env bun
//
// Uploads dist/ to the Cloudflare R2 bucket that backs the map-assets CDN, preserving the
// directory layout (keys match URL paths). Uses Bun's built-in S3 client against R2's
// S3-compatible API.
//
// Required env (or .env in this repo):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//
// Usage:
//   bun run deploy            # upload everything in dist/
//   bun run deploy pov        # only dist/pov/**
//   bun run deploy basemap    # only dist/basemap-*.pmtiles
//   bun run deploy fonts      # only dist/fonts/**
//
// Cache policy lives in Cloudflare (Cache Rules on the CDN zone), not in object metadata:
//   basemap-*.pmtiles, pov/*  -> cache everything, long TTL (paths are versioned)
//   fonts/*                   -> cache everything, moderate TTL

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { S3Client } from 'bun'
import { DIST } from './config'

const required = (name: string) => {
  const v = process.env[name]
  if (!v) {
    console.error(`error: ${name} is not set`)
    process.exit(1)
  }
  return v
}

const accountId = required('R2_ACCOUNT_ID')
const s3 = new S3Client({
  accessKeyId: required('R2_ACCESS_KEY_ID'),
  secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
  bucket: required('R2_BUCKET'),
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
})

const CONTENT_TYPES: Record<string, string> = {
  '.pmtiles': 'application/octet-stream',
  '.pbf': 'application/x-protobuf',
  '.json': 'application/json',
}

const contentType = (path: string) => {
  for (const [ext, type] of Object.entries(CONTENT_TYPES)) {
    if (path.endsWith(ext)) return type
  }
  return 'application/octet-stream'
}

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const target = process.argv[2] ?? 'all'
const matchesTarget = (key: string) => {
  if (target === 'all') return true
  if (target === 'pov') return key.startsWith('pov/')
  if (target === 'basemap') return key.startsWith('basemap-')
  if (target === 'fonts') return key.startsWith('fonts/')
  console.error(`error: unknown target '${target}' (expected all | pov | basemap | fonts)`)
  process.exit(1)
}

const files = walk(DIST)
  .map(path => ({ path, key: relative(DIST, path) }))
  .filter(({ key }) => matchesTarget(key))

if (files.length === 0) {
  console.error(`error: nothing to upload for target '${target}' — run \`bun run build\` first.`)
  process.exit(1)
}

const CONCURRENCY = 20
const totalBytes = files.reduce((sum, { path }) => sum + statSync(path).size, 0)
let doneBytes = 0
let uploaded = 0

const BAR_WIDTH = 30
const renderBar = () => {
  const pct = totalBytes === 0 ? 1 : doneBytes / totalBytes
  const filled = Math.round(pct * BAR_WIDTH)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1)
  process.stdout.write(`\r[${bar}] ${Math.round(pct * 100)}%  ${mb(doneBytes)}/${mb(totalBytes)} MB  (${uploaded}/${files.length} files)`)
}

renderBar()
const queue = [...files]
const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length > 0) {
    const file = queue.shift()!
    const size = statSync(file.path).size
    await s3.write(file.key, Bun.file(file.path), { type: contentType(file.key) })
    doneBytes += size
    uploaded++
    renderBar()
  }
})
await Promise.all(workers)

process.stdout.write('\n')
console.log(`Uploaded ${uploaded} files, ${(doneBytes / 1024 / 1024).toFixed(1)}MB total.`)
