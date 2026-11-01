import { join } from 'node:path'

// Pinned Protomaps daily planet build (OSM replication date). Bumping this re-points the whole
// pipeline; the app pins the same date in its src/lib/map-assets.ts and must be bumped together.
export const BASEMAP_BUILD_DATE = '20260608'

// Max zoom of the basemap extract. The z8 tier roughly doubled the archive to ~522MiB — just over
// Cloudflare's 512MiB max-cacheable-object size, so the whole file was served `cf-cache-status:
// BYPASS` and every pmtiles range request hit R2 origin (slow, tiles trickling in one at a time).
// Capping at z7 drops the extract to ~270MiB so the archive edge-caches as a whole. The dashboard
// maps still run to z8 — MapLibre overzooms the z7 tiles (scaled up) at the deepest zoom, a minor
// softness only there. Bump back to 8 only if the archive can be kept under the cap another way
// (e.g. a per-tile caching Worker in front of R2).
export const MAXZOOM = 7

// world-atlas resolution the activity choropleth is built from. 110m cannot resolve narrow
// salients: it renders Tawang — a 13km-wide Indian neck between Bhutan and Tibet — as Bhutan,
// which is wrong in a direction nobody claims (the country that contests Tawang is China). 50m
// resolves it. The app imports the same file and must be kept on the same scale.
export const CHOROPLETH_SCALE = '50m'

export const ROOT = join(import.meta.dir, '..')
export const DIST = join(ROOT, 'dist')
export const CACHE = join(ROOT, '.cache')

// Version of the POV data itself, independent of the basemap it was derived from. The POV outputs
// change for reasons the basemap date cannot express — a different correction source, a different
// choropleth scale, a fix to the generator — and `pov/*` is served with a one-year immutable
// edge+browser TTL on the assumption that its paths never change content. Without this second pin
// the only ways to ship a POV fix would be re-fetching a 178MB extract that did not need to change,
// or purging the CDN and still leaving every returning browser on the old data for a year.
//
// Bump whenever the bytes under pov/ change. v1 was the unsuffixed `pov/<date>/` path.
export const POV_DATA_VERSION = 3

// Artifact layout, mirrored 1:1 to the R2 bucket (and to the app's public/ for local dev):
//   basemap-<date>.pmtiles              versioned -> cache immutable
//   fonts/<stack>/<range>.pbf           unversioned, effectively static
//   pov/<date>-<v>/countries-patch.json pinned to both the basemap and the POV data version
//   pov/<date>-<v>/claim-lines.json     CC BY 4.0 — Natural Earth + DataMeet's Kalapani polygon
//   pov/<date>-<v>/disputed-lines.json  ODbL 1.0 — re-extracted from the OSM-derived basemap tiles
//
// The two line files are separate because they carry different licences: merging them, as this
// pipeline used to, makes the whole thing ODbL and unusable to anyone who cannot take share-alike.
export const BASEMAP_FILENAME = `basemap-${BASEMAP_BUILD_DATE}.pmtiles`
export const POV_DIR = `pov/${BASEMAP_BUILD_DATE}-${POV_DATA_VERSION}`
export const POV_COUNTRIES_PATCH = `${POV_DIR}/countries-patch.json`
export const POV_CLAIM_LINES = `${POV_DIR}/claim-lines.json`
export const POV_DISPUTED_LINES = `${POV_DIR}/disputed-lines.json`
