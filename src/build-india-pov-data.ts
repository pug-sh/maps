#!/usr/bin/env bun
//
// Generates the India point-of-view (POV) geo data into dist/pov/<date>-<version>/:
//
//   - countries-patch.json   Replacement geometries for the choropleth base, keyed the way the
//                            app keys world-atlas features. Every country the correction touches
//                            is rewritten: India gains each region, each de-facto country loses
//                            exactly the same polygon, so the two sides share a seam and no gap or
//                            overlap can open between them. CC BY 4.0: the Kalapani polygon is
//                            merged in; the rest is public domain.
//   - claim-lines.json       Boundary India draws that no de-facto boundary carries — its official
//                            outer edge through Kashmir and around Kalapani. CC BY 4.0 for the
//                            Kalapani feature, public domain for the rest.
//   - disputed-lines.json    The `disputed`-flagged OSM segments that official Indian maps DO
//                            draw (Jammu International Border, middle sector, McMahon line) plus
//                            every disputed line outside the India zone (Crimea, Western Sahara,
//                            ...), re-extracted verbatim from the tiles so they reconnect exactly
//                            with visible borders. ODbL 1.0 — see the licence note in config.ts.
//                            What stays hidden: the Line of Control, the LAC around Aksai Chin,
//                            and the 1963 Pakistan-China line.
//
// The correction is expressed as a set of named regions (see pov-sources.ts) and applied by set
// difference, so it reaches wherever a region sits. There is no correction window: an earlier
// version patched only a hardcoded Kashmir bounding box, which silently left Kalapani — outside it
// on both axes — uncorrected however good the source was.
//
// Sources:
//   - Natural Earth 10m admin_0_countries          (de-facto worldview; fetched, cached in .cache/)
//   - Natural Earth 10m admin_0_disputed_areas     (named regions + worldview columns)
//   - DataMeet Country/disputed/india-disputed-lsib (Kalapani; CC BY 4.0)
//   - world-atlas countries-<scale>                (choropleth base, from node_modules)
//   - dist/basemap-<date>.pmtiles                  (run `bun run fetch` first)
//
// Usage: bun run generate

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { VectorTile } from '@mapbox/vector-tile'
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson'
import Pbf from 'pbf'
import { PMTiles } from 'pmtiles'
import {
  BASEMAP_BUILD_DATE,
  BASEMAP_FILENAME,
  CHOROPLETH_SCALE,
  DIST,
  POV_CLAIM_LINES,
  POV_COUNTRIES_PATCH,
  POV_DISPUTED_LINES,
} from './config'
import { reportConformance, runConformance } from './conformance'
import {
  type MultiPoly,
  areaKm2,
  asMultiPoly,
  contains,
  difference,
  intersection,
  perpDist,
  roundCoord,
  round,
  simplify,
  simplifyRing,
  toMultiPolygon,
  union,
  vertexCount,
} from './geo'
import {
  type Region,
  WORLDVIEW,
  baseKey,
  buildAdminIndex,
  describeRegions,
  fetchNe,
  findCountry,
  loadBaseCollection,
  loadRegions,
  regionParties,
  regionUnion,
} from './pov-sources'

// Detail the region geometry is reduced to before it is merged into the choropleth base. Natural
// Earth 10m is far finer than world-atlas 50m; ~550m keeps the smallest region (Kalapani, 60km²)
// intact while dropping the vertices the base could never show.
const REGION_TOLERANCE = 0.005

// --- Choropleth patch ---------------------------------------------------------------------------
//
// India = base(India) ∪ correction, each de-facto country = base(country) − correction, with the
// correction first clipped to the union of the parties' own base geometry. That clip is what keeps
// the seams honest: Natural Earth 10m and world-atlas disagree about where any given border runs by
// a couple of kilometres, so an unclipped correction would eat slivers of Afghanistan along the
// Gilgit-Baltistan frontier (229km² at 110m, 55km² at 50m — measured) and leave its outer edge
// floating off the base's coastline. Clipped, the union of the patched shapes equals the union of
// the base shapes exactly: no area is created or destroyed, only reassigned.

const buildCountriesPatch = (base: FeatureCollection, fact: FeatureCollection, regions: Region[]) => {
  const adminIndex = buildAdminIndex(fact, base)
  const parties = new Map<string, Feature>()
  for (const a3 of regionParties(regions)) {
    const f = adminIndex.get(a3)
    if (!f) {
      console.warn(`  warning: party ${a3} has no feature in the ${CHOROPLETH_SCALE} base — skipped`)
      continue
    }
    parties.set(a3, f)
  }

  if (!parties.has(WORLDVIEW.a3)) throw new Error(`${WORLDVIEW.a3} missing from the ${CHOROPLETH_SCALE} base`)

  const scope = union(...[...parties.values()].map(f => asMultiPoly(f.geometry as Polygon | MultiPolygon)))
  const correction = intersection(simplify(regionUnion(regions), REGION_TOLERANCE), scope)

  const patch: Record<string, MultiPolygon> = {}
  for (const [a3, f] of parties) {
    const shape = asMultiPoly(f.geometry as Polygon | MultiPolygon)
    const patched = a3 === WORLDVIEW.a3 ? union(shape, correction) : difference(shape, correction)
    patch[baseKey(f)] = toMultiPolygon(round(patched))
    const delta = areaKm2(patched) - areaKm2(shape)
    const pct = (delta / areaKm2(shape)) * 100
    console.log(
      `  ${String((f.properties as Record<string, string>)?.name).padEnd(18)} ${baseKey(f).padEnd(20)}` +
        ` ${shape.length} -> ${patched.length} polys, ${delta >= 0 ? '+' : ''}${delta.toFixed(0)} km² (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
    )
  }
  return patch
}

// --- Boundary lines (claim-lines.json) ----------------------------------------------------------
//
// The boundary of each region, minus everything already drawn. A segment is dropped when it is
// shared with an adjacent region (interior to India's official outline — this is what removes the
// Line of Control and the LAC), when it coincides with a de-facto country ring (already on the
// basemap), or when it lies inside India's de-facto territory (an internal administrative line,
// such as the southern edge of Jammu & Kashmir or the whole of Junagadh).

const segKey = (a: Position, b: Position) => {
  const ka = `${a[0].toFixed(6)},${a[1].toFixed(6)}`
  const kb = `${b[0].toFixed(6)},${b[1].toFixed(6)}`
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
}

const bboxOf = (mp: MultiPoly): [number, number, number, number] => {
  let x0 = 180
  let y0 = 90
  let x1 = -180
  let y1 = -90
  for (const poly of mp)
    for (const ring of poly)
      for (const [x, y] of ring) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
  return [x0, y0, x1, y1]
}

const within = ([x0, y0, x1, y1]: [number, number, number, number], p: Position) =>
  p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1

const buildBoundaryLines = (regions: Region[], fact: FeatureCollection) => {
  const regionBox = bboxOf(regionUnion(regions))
  const pad: [number, number, number, number] = [regionBox[0] - 1, regionBox[1] - 1, regionBox[2] + 1, regionBox[3] + 1]

  // Segments already carried by some de-facto country ring, near the regions.
  const factSegs = new Set<string>()
  for (const f of fact.features)
    for (const poly of asMultiPoly(f.geometry as Polygon | MultiPolygon))
      for (const ring of poly)
        for (let i = 1; i < ring.length; i++)
          if (within(pad, ring[i - 1]) || within(pad, ring[i])) factSegs.add(segKey(ring[i - 1], ring[i]))

  // Segments appearing in more than one region are interior to India's official outline.
  const shared = new Map<string, number>()
  for (const r of regions)
    for (const poly of r.geometry)
      for (const ring of poly)
        for (let i = 1; i < ring.length; i++) {
          const k = segKey(ring[i - 1], ring[i])
          shared.set(k, (shared.get(k) ?? 0) + 1)
        }

  const indiaShape = findCountry(fact, 'India')
  const features: Feature[] = []
  for (const r of regions) {
    const lines: Position[][] = []
    for (const poly of r.geometry)
      for (const ring of poly) {
        let run: Position[] = []
        for (let i = 1; i < ring.length; i++) {
          const [a, b] = [ring[i - 1], ring[i]]
          const k = segKey(a, b)
          const mid: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
          const draw = (shared.get(k) ?? 0) < 2 && !factSegs.has(k) && !contains(indiaShape, mid)
          if (draw) {
            if (run.length === 0) run.push(a)
            run.push(b)
          } else {
            if (run.length > 1) lines.push(run)
            run = []
          }
        }
        if (run.length > 1) lines.push(run)
      }
    if (!lines.length) continue
    features.push({
      type: 'Feature',
      geometry: {
        type: 'MultiLineString',
        coordinates: lines.map(line => simplifyRing(line, 0.002).map(roundCoord)),
      },
      properties: {
        name: r.name,
        brk_a3: r.brkA3,
        source: r.source,
        licence: r.licence,
      },
    })
  }

  const total = features.reduce((n, f) => n + (f.geometry as { coordinates: Position[][] }).coordinates.length, 0)
  console.log(`Boundary lines: ${features.length} regions contribute ${total} line strings`)
  for (const f of features)
    console.log(
      `  ${String(f.properties?.name).padEnd(28)} ${(f.geometry as { coordinates: Position[][] }).coordinates.length} lines`,
    )
  return features
}

// --- Disputed OSM segments that should still be drawn ---------------------------------------------
//
// The dashboard's live-map style hides every boundary segment the tiles flag `disputed`. In the
// India zone that correctly removes the LoC / LAC / 1963 Pakistan-China line, but OSM also flags
// long stretches of boundary that official Indian maps draw as plain international borders (the
// Jammu International Border, middle sector, McMahon line, Kalapani). Outside the India zone hiding
// is not wanted at all. So: extract every disputed country-level line from the tiles, and keep it
// unless it sits in the India zone without coinciding with a boundary India recognises — India's
// official outline, or any de-facto ring belonging to a country that is not party to these disputes
// (the party rings are exactly the ones carrying the LoC, the LAC and the 1963 line).

const EPS_DEG = 0.04 // ~4.4km — NE 10m vs OSM divergence along a shared boundary stays well under this

// Spatial grid over reference segments for fast point-to-boundary distance tests.
const buildRefIndex = (regions: Region[], fact: FeatureCollection, zone: [number, number, number, number]) => {
  const cell = 0.2
  const grid = new Map<string, [Position, Position][]>()
  const addRing = (ring: Position[]) => {
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]]
      if (!within(zone, a) && !within(zone, b)) continue
      const minX = Math.floor(Math.min(a[0], b[0]) / cell)
      const maxX = Math.floor(Math.max(a[0], b[0]) / cell)
      const minY = Math.floor(Math.min(a[1], b[1]) / cell)
      const maxY = Math.floor(Math.max(a[1], b[1]) / cell)
      for (let x = minX; x <= maxX; x++)
        for (let y = minY; y <= maxY; y++) {
          const key = `${x},${y}`
          let list = grid.get(key)
          if (!list) grid.set(key, (list = []))
          list.push([a, b])
        }
    }
  }
  const addShape = (mp: MultiPoly) => {
    for (const poly of mp) for (const ring of poly) addRing(ring)
  }

  // India's official outline — the de-facto shape merged with every region. It has to be the merged
  // outline, not the regions one by one: the edge Jammu & Kashmir shares with Pakistan-occupied
  // Kashmir is the Line of Control, and the edge it shares with Aksai Chin is the LAC. Those are
  // interior to the union and vanish from it, which is exactly what should happen — they are the
  // two lines this whole pipeline exists to stop drawing.
  addShape(union(findCountry(fact, 'India'), regionUnion(regions)))
  const parties = regionParties(regions)
  for (const f of fact.features) {
    if (parties.has(String((f.properties as Record<string, string>).ADM0_A3))) continue
    addShape(asMultiPoly(f.geometry as Polygon | MultiPolygon))
  }

  const segDist = (p: Position, [a, b]: [Position, Position]) => {
    const kx = Math.cos((p[1] * Math.PI) / 180) // shrink lon so distances are roughly isotropic
    const scaled: Position = [p[0] * kx, p[1]]
    return perpDist(scaled, [a[0] * kx, a[1]], [b[0] * kx, b[1]])
  }

  return (p: Position) => {
    const cx = Math.floor(p[0] / cell)
    const cy = Math.floor(p[1] / cell)
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const seg of grid.get(`${x},${y}`) ?? []) {
          if (segDist(p, seg) < EPS_DEG) return true
        }
      }
    return false
  }
}

const SWEEP_ZOOM = 5
const EXTRACT_ZOOM = 7

type TileLine = { coords: Position[]; brkA3: string | null }

const loadDisputedLines = async (
  onRecognisedBoundary: (p: Position) => boolean,
  zone: [number, number, number, number],
  regionsByBrk: Map<string, Region>,
) => {
  const path = join(DIST, BASEMAP_FILENAME)
  if (!existsSync(path)) {
    console.error(`error: dist/${BASEMAP_FILENAME} missing — run \`bun run fetch\` first.`)
    process.exit(1)
  }
  const buf = readFileSync(path)
  const pm = new PMTiles({
    getKey: () => 'local',
    getBytes: async (offset: number, length: number) => ({ data: buf.buffer.slice(offset, offset + length) }),
  })

  const disputedLines = async (z: number, x: number, y: number): Promise<TileLine[]> => {
    const t = await pm.getZxy(z, x, y)
    if (!t) return []
    const layer = new VectorTile(new Pbf(new Uint8Array(t.data))).layers['boundaries']
    if (!layer) return []
    const lines: TileLine[] = []
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.properties.kind !== 'country' || f.properties.disputed !== true) continue
      const brkA3 = typeof f.properties.brk_a3 === 'string' ? f.properties.brk_a3 : null
      const geom = f.toGeoJSON(x, y, z).geometry
      if (geom.type === 'LineString') lines.push({ coords: geom.coordinates, brkA3 })
      if (geom.type === 'MultiLineString') for (const c of geom.coordinates) lines.push({ coords: c, brkA3 })
    }
    return lines
  }

  // Sweep the world at low zoom to find tiles containing disputed lines, then re-extract those
  // areas at a zoom fine enough for the basemap's max display zoom.
  const hits: [number, number][] = []
  const n = 2 ** SWEEP_ZOOM
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) {
      if ((await disputedLines(SWEEP_ZOOM, x, y)).length > 0) hits.push([x, y])
    }

  const step = 2 ** (EXTRACT_ZOOM - SWEEP_ZOOM)
  const lines: TileLine[] = []
  for (const [sx, sy] of hits)
    for (let dx = 0; dx < step; dx++)
      for (let dy = 0; dy < step; dy++) {
        lines.push(...(await disputedLines(EXTRACT_ZOOM, sx * step + dx, sy * step + dy)))
      }

  // Keep runs of segments that are outside the India zone or coincide with a recognised boundary.
  const kept: TileLine[] = []
  for (const line of lines) {
    let run: Position[] = []
    const flush = () => {
      if (run.length > 1) kept.push({ coords: run, brkA3: line.brkA3 })
      run = []
    }
    for (let i = 1; i < line.coords.length; i++) {
      const [a, b] = [line.coords[i - 1], line.coords[i]]
      const zoned = within(zone, a) || within(zone, b)
      if (!zoned || (onRecognisedBoundary(a) && onRecognisedBoundary(b))) {
        if (run.length === 0) run.push(a)
        run.push(b)
      } else flush()
    }
    flush()
  }
  console.log(`Disputed lines: ${lines.length} raw, ${kept.length} kept after classification`)

  return kept.map((line): Feature => {
    const region = line.brkA3 ? regionsByBrk.get(line.brkA3) : undefined
    return {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: simplifyRing(line.coords, 0.005).map(roundCoord),
      },
      properties: {
        brk_a3: line.brkA3,
        // A name is carried only where the tile's Natural Earth breakaway code identifies the
        // territory; segments without one keep a null rather than an invented name.
        name: region?.name ?? null,
        source: 'OpenStreetMap via Protomaps basemap tiles',
        licence: 'ODbL-1.0',
      },
    }
  })
}

const writeCollection = (
  relPath: string,
  features: Feature[],
  meta: Record<string, unknown>,
) => {
  const collection = { type: 'FeatureCollection', features, ...meta }
  const path = join(DIST, relPath)
  mkdirSync(dirname(path), { recursive: true })
  const json = JSON.stringify(collection)
  writeFileSync(path, json)
  console.log(`Wrote ${path} (${(json.length / 1024).toFixed(0)}KB, ${features.length} features)`)
}

// CC BY 4.0 §3(a) asks for the source, a link to it, the licence and a note that it was modified.
const KALAPANI_CREDIT =
  'Kalapani: LSIB (U.S. Dept. of State) via DataMeet, ' +
  'https://github.com/datameet/maps/blob/master/Country/disputed/india-disputed-lsib.geojson, modified, ' +
  'CC BY 4.0 https://creativecommons.org/licenses/by/4.0/'

// --- Main ---------------------------------------------------------------------------------------

const fact = await fetchNe('ne_10m_admin_0_countries')
const regions = await loadRegions()
describeRegions(regions)

const base = loadBaseCollection()
console.log(`\nChoropleth patch (world-atlas ${CHOROPLETH_SCALE}, ${base.features.length} features):`)
const patch = buildCountriesPatch(base, fact, regions)
const patchPath = join(DIST, POV_COUNTRIES_PATCH)
mkdirSync(dirname(patchPath), { recursive: true })
// The credit sits beside the geometry keys rather than wrapping them: the app looks geometries up
// by country key and ignores anything else, so this shape stays compatible with it.
const patchJson = JSON.stringify({
  licence: 'CC-BY-4.0',
  attribution: `world-atlas / Natural Earth (public domain); ${KALAPANI_CREDIT}`,
  ...patch,
})
writeFileSync(patchPath, patchJson)
console.log(
  `Wrote ${patchPath} (${(patchJson.length / 1024).toFixed(0)}KB, ${Object.keys(patch).length} countries,` +
    ` ${Object.values(patch).reduce((n, g) => n + vertexCount(g.coordinates as MultiPoly), 0)} vertices)`,
)

console.log('')
const boundaryLines = buildBoundaryLines(regions, fact)
writeCollection(POV_CLAIM_LINES, boundaryLines, {
  licence: 'CC-BY-4.0',
  attribution: `Natural Earth (public domain); ${KALAPANI_CREDIT}`,
  worldview: WORLDVIEW.a3,
  basemapBuildDate: BASEMAP_BUILD_DATE,
})

console.log('')
// Disputed-line classification only has an opinion where the regions sit; a degree of padding
// covers the divergence between the tiles and Natural Earth along the same boundary.
const regionBox = bboxOf(regionUnion(regions))
const zone: [number, number, number, number] = [regionBox[0] - 5, regionBox[1] - 5, regionBox[2] + 5, regionBox[3] + 5]
console.log(`Correction zone: lon ${zone[0].toFixed(1)}–${zone[2].toFixed(1)}, lat ${zone[1].toFixed(1)}–${zone[3].toFixed(1)}`)
const regionsByBrk = new Map(regions.filter(r => r.brkA3).map(r => [r.brkA3 as string, r]))
const disputedLines = await loadDisputedLines(buildRefIndex(regions, fact, zone), zone, regionsByBrk)
writeCollection(POV_DISPUTED_LINES, disputedLines, {
  licence: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  worldview: WORLDVIEW.a3,
  basemapBuildDate: BASEMAP_BUILD_DATE,
})

const failures = reportConformance(runConformance(base, patch))
if (failures.length) {
  console.error(`\n${failures.length} conformance failure(s) — not shipping this. See src/conformance.ts.`)
  process.exit(1)
}
