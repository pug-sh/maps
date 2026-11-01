// Source data for the point-of-view corrections, and the regions derived from it.
//
// A *worldview* is one country's official depiction of contested territory. Natural Earth models
// this directly: `ne_10m_admin_0_disputed_areas` carries one polygon per contested territory, with
// an `ADM0_A3_<XX>` column per published worldview saying who that worldview considers the
// administrator. Filtering on `ADM0_A3_IN` yields, as named and individually attributed polygons,
// exactly the territory India's official maps show as Indian.
//
// This is the same geometry `ne_10m_admin_0_countries_ind` encodes — verified: the union of the
// regions where India's worldview disagrees with the de-facto file is identical to
// `_ind(India) − de-facto(India)`, 116,310 km² either way, symmetric difference empty — but as
// discrete, named territories rather than one opaque outline, which makes each correction
// individually auditable.
//
// Natural Earth models one sector of India's boundary only partially: Kalapani / Limpiyadhura /
// Lipulekh, at the India-Nepal-China trijunction. Its de-facto file already puts most of the sector
// in India, but not the Lipulekh pass, and no NE worldview column moves it. The only published
// polygon that models this as a discrete territory is LSIB's, redistributed by DataMeet, so that
// one region comes from there. It is CC BY 4.0 — DataMeet's repo-wide default; the CC-0 in their
// Country README covers only `india-composite.geojson` — so every output it reaches has to credit
// DataMeet.
//
// DataMeet also publishes a whole-country outline (`india-composite.geojson`, CC-0) which looks
// like the obvious source to switch to wholesale. It is not: it is LSIB-derived and is a *land*
// polygon, so differencing it against Natural Earth's political outline yields ~1450 components
// and ~10,000km² of misregistration — coastlines, backwaters, border noise up to 918km² per
// component, indistinguishable by area from the Kalapani region itself. The correction has to
// come from one source family, which is what the disputed-areas file gives.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import { CACHE, CHOROPLETH_SCALE, ROOT } from './config'
import { type MultiPoly, areaKm2, asMultiPoly, union } from './geo'

const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'
const DATAMEET_BASE = 'https://raw.githubusercontent.com/datameet/maps/master'

// The worldview being built. `a3` is the ISO alpha-3 of the country whose depiction we follow;
// `neColumn` is Natural Earth's per-worldview column for it.
export const WORLDVIEW = { a3: 'IND', neColumn: 'ADM0_A3_IN' } as const

// Natural Earth's names, except where Indian usage differs.
const INDIAN_NAMES: Record<string, string> = { B06: 'Shaksgam Valley', B09: 'Pakistan-occupied Kashmir' }

export type Region = {
  /** Territory name, e.g. 'Aksai Chin'. */
  name: string
  /** Natural Earth breakaway code, e.g. 'B07'. Joins to the Protomaps boundaries layer's `brk_a3`. */
  brkA3: string | null
  /** ISO alpha-3 (or Natural Earth ADM0_A3) of the countries the de-facto data assigns this region to. */
  deFacto: string[]
  source: string
  licence: string
  geometry: MultiPoly
}

const cached = async (name: string, url: string) => {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, `${name}.geojson`)
  if (!existsSync(path)) {
    console.log(`Fetching ${name}...`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`failed to fetch ${name}: ${res.status}`)
    writeFileSync(path, await res.text())
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection
}

export const fetchNe = (name: string) => cached(name, `${NE_BASE}/${name}.geojson`)

const fetchDataMeet = (path: string) =>
  cached(`datameet_${path.split('/').pop()?.replace(/\.geojson$/, '')}`, `${DATAMEET_BASE}/${path}`)

export const findCountry = (fc: FeatureCollection, admin: string) => {
  const f = fc.features.find(f => (f.properties as Record<string, unknown>)?.ADMIN === admin)
  if (!f) throw new Error(`country not found: ${admin}`)
  return asMultiPoly(f.geometry as Polygon | MultiPolygon)
}

// --- Regions ---

export const loadRegions = async (): Promise<Region[]> => {
  const disputed = await fetchNe('ne_10m_admin_0_disputed_areas')
  const regions: Region[] = []

  for (const f of disputed.features) {
    const p = f.properties as Record<string, string>
    if (p[WORLDVIEW.neColumn] !== WORLDVIEW.a3) continue
    regions.push({
      name: INDIAN_NAMES[p.BRK_A3] ?? p.BRK_NAME,
      brkA3: p.BRK_A3 ?? null,
      deFacto: [p.ADM0_A3],
      source: 'Natural Earth 10m admin_0_disputed_areas',
      licence: 'public domain',
      geometry: asMultiPoly(f.geometry as Polygon | MultiPolygon),
    })
  }

  // Kalapani / Limpiyadhura / Lipulekh. The de-facto countries are declared rather than derived:
  // against Natural Earth 10m the polygon overlaps three countries' shapes (37.9 km² India,
  // 18.4 km² China, 3.5 km² Nepal), and only the latter two lose area here.
  const lsib = await fetchDataMeet('Country/disputed/india-disputed-lsib.geojson')
  const kalapani = lsib.features.find(f => (f.properties as Record<string, string>).COUNTRY_NA === 'Kalapani (disp)')
  if (!kalapani) throw new Error('DataMeet india-disputed-lsib: "Kalapani (disp)" feature missing')
  regions.push({
    name: 'Kalapani',
    brkA3: null,
    deFacto: ['NPL', 'CHN'],
    source: 'LSIB (U.S. Dept. of State) via DataMeet maps, Country/disputed/india-disputed-lsib',
    licence: 'CC-BY-4.0',
    geometry: asMultiPoly(kalapani.geometry as Polygon | MultiPolygon),
  })

  return regions
}

/** India plus every country the de-facto data assigns part of a region to. */
export const regionParties = (regions: Region[]) => new Set([WORLDVIEW.a3, ...regions.flatMap(r => r.deFacto)])

export const regionUnion = (regions: Region[]) => union(...regions.map(r => r.geometry))

export const describeRegions = (regions: Region[]) => {
  console.log(`Regions (worldview ${WORLDVIEW.a3}): ${regions.length}`)
  for (const r of regions)
    console.log(
      `  ${r.name.padEnd(28)} ${r.brkA3 ?? '   '} de-facto ${r.deFacto.join('+').padEnd(8)}` +
        ` ${areaKm2(r.geometry).toFixed(0).padStart(7)} km²  ${r.licence}`,
    )
}

// --- Choropleth base (world-atlas TopoJSON) ---

/**
 * Stable patch key for a base feature. world-atlas ids are UN M49 numeric codes, but a handful of
 * features carry no id at all (Kosovo, N. Cyprus, Somaliland, and at 50m also Siachen Glacier and
 * Indian Ocean Ter.), so those key on name instead. The app derives the key the same way.
 */
export const baseKey = (f: Feature) => {
  const id = f.id === undefined || f.id === null ? '' : String(f.id)
  return id === '' ? `name:${(f.properties as Record<string, string>)?.name}` : id.padStart(3, '0')
}

export const loadBaseCollection = () => {
  const path = join(ROOT, 'node_modules', 'world-atlas', `countries-${CHOROPLETH_SCALE}.json`)
  const topo = JSON.parse(readFileSync(path, 'utf8')) as Topology
  return feature(topo, topo.objects.countries) as FeatureCollection
}

/**
 * Natural Earth ADM0_A3 → base-collection key, so a region's de-facto countries can be located in
 * the choropleth base. Codes with no ISO numeric (Natural Earth uses -99 for
 * Siachen Glacier and other non-sovereign entries) fall back to matching on name.
 */
export const buildAdminIndex = (fact: FeatureCollection, base: FeatureCollection) => {
  const byKey = new Map<string, Feature>()
  const byName = new Map<string, Feature>()
  for (const f of base.features) {
    byKey.set(baseKey(f), f)
    byName.set(String((f.properties as Record<string, string>)?.name), f)
  }

  const index = new Map<string, Feature>()
  for (const f of fact.features) {
    const p = f.properties as Record<string, string>
    const iso = String(p.ISO_N3 ?? '')
    const hit = (/^\d+$/.test(iso) ? byKey.get(iso.padStart(3, '0')) : undefined) ?? byName.get(p.ADMIN)
    if (hit) index.set(p.ADM0_A3, hit)
  }
  return index
}
