#!/usr/bin/env bun
//
// Conformance harness: named places with the owner India's official depiction gives them, checked
// against the *built* choropleth — the world-atlas base with the generated countries-patch.json
// applied, exactly as the app assembles it. Source-level checks are not enough: some defects live
// in the base rather than in the point-of-view data (Tawang rendered as Bhutan at 110m, audit
// finding 2), and only a check on the built artifact catches those.
//
// `bun run generate` runs this and fails the build on any miss. Run it standalone against whatever
// is currently in dist/ with:  bun run verify
//
// Coordinates are the places themselves, so a miss means the artifact disagrees with India's
// depiction at a real location, not that a probe drifted off a line. Two probes sit close enough
// to a border to be worth knowing about: Kalapani is ~3km from the Nepal line as Natural Earth
// draws it, and Lipulekh is a pass on the China line. Both are inside India's depiction, both are
// meant to be here — they are the two the correction exists to get right.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson'
import { DIST, POV_COUNTRIES_PATCH } from './config'
import { asMultiPoly, contains } from './geo'
import { baseKey, loadBaseCollection } from './pov-sources'

export type ConformancePoint = {
  name: string
  at: Position
  /** world-atlas `properties.name` of the country India's depiction assigns this place to. */
  expect: string
}

const POINTS: ConformancePoint[] = [
  // Kashmir sector — the reason this pipeline exists.
  { name: 'Gilgit (Gilgit-Baltistan)', at: [74.3144, 35.9208], expect: 'India' },
  { name: 'Muzaffarabad (Pakistan-occupied Kashmir)', at: [73.4711, 34.37], expect: 'India' },
  { name: 'Aksai Chin', at: [79.0, 35.2], expect: 'India' },
  { name: 'Shaksgam valley', at: [76.5, 35.9], expect: 'India' },
  { name: 'Siachen', at: [77.1, 35.42], expect: 'India' },
  { name: 'Demchok', at: [79.45, 32.7], expect: 'India' },
  // Nepal trijunction — audit finding 1.
  { name: 'Kalapani', at: [80.85, 30.18], expect: 'India' },
  { name: 'Lipulekh', at: [81.02, 30.23], expect: 'India' },
  { name: 'Limpiyadhura', at: [80.62, 30.25], expect: 'India' },
  // Arunachal Pradesh — audit finding 2; Tawang is a narrow salient between Bhutan and Tibet.
  { name: 'Tawang', at: [91.8594, 27.5861], expect: 'India' },
  { name: 'Walong (E Arunachal)', at: [97.0, 28.13], expect: 'India' },
  // Negative controls: places the correction must leave alone.
  { name: 'Lahore (PK)', at: [74.3436, 31.5497], expect: 'Pakistan' },
  { name: 'Kashgar (CN)', at: [75.9898, 39.4704], expect: 'China' },
  { name: 'Colombo (LK)', at: [79.8612, 6.9271], expect: 'Sri Lanka' },
]

export type ConformanceRow = ConformancePoint & { got: string[] }

const nameOf = (f: Feature) => String((f.properties as Record<string, string>)?.name ?? baseKey(f))

/**
 * Rebuild the patched collection the way the app does, then locate every point. Returns *all*
 * countries containing each point, not just the first — a point owned by two countries means the
 * patch left an overlap, which is as much a defect as a miss.
 */
export const runConformance = (base: FeatureCollection, patch: Record<string, MultiPolygon>): ConformanceRow[] => {
  const shapes = base.features.map(f => ({
    name: nameOf(f),
    geometry: asMultiPoly(patch[baseKey(f)] ?? (f.geometry as Polygon | MultiPolygon)),
  }))
  return POINTS.map(p => ({ ...p, got: shapes.filter(s => contains(s.geometry, p.at)).map(s => s.name) }))
}

export const reportConformance = (rows: ConformanceRow[]) => {
  const ok = (r: ConformanceRow) => r.got.length === 1 && r.got[0] === r.expect
  const width = Math.max(...POINTS.map(p => p.name.length))
  console.log(`\nConformance (${rows.filter(ok).length}/${rows.length})`)
  for (const r of rows) {
    const got = r.got.length === 0 ? '(unclaimed)' : r.got.join(' + ')
    console.log(`  ${ok(r) ? 'ok  ' : 'FAIL'} ${r.name.padEnd(width)}  want ${r.expect.padEnd(9)} got ${got}`)
  }
  return rows.filter(r => !ok(r))
}

if (import.meta.main) {
  const path = join(DIST, POV_COUNTRIES_PATCH)
  if (!existsSync(path)) {
    console.error(`error: ${path} missing — run \`bun run generate\` first.`)
    process.exit(1)
  }
  const patch = JSON.parse(readFileSync(path, 'utf8')) as Record<string, MultiPolygon>
  const failures = reportConformance(runConformance(loadBaseCollection(), patch))
  if (failures.length) process.exit(1)
}
