# pug-maps

Builds the self-hosted map assets for the Pug dashboard. Artifacts are deployed to a Cloudflare
R2 bucket and served through the Cloudflare CDN (e.g. `maps.<domain>`); the dashboard never
loads map data from third-party tile servers.

```
bun run fetch        dist/basemap-<date>.pmtiles + dist/fonts/      (raw assets)
bun run generate     dist/pov/<date>-<v>/*.json                    (India-POV data)
bun run verify       re-run the conformance harness on dist/       (generate runs it too)
bun run build        fetch + generate
bun run sync:app     wire dist/ into ../app/public for local dev
bun run deploy       upload dist/ to R2 (all | pov | basemap | fonts)
```

## Artifacts

| Key | What | Licence | Cache |
| --- | --- | --- | --- |
| `basemap-<date>.pmtiles` | z0–z7 global extract of the Protomaps daily planet build (~270MB) | ODbL 1.0 | edge + browser (kept under the 512MiB cap — see below) |
| `fonts/<stack>/<range>.pbf` | Noto Sans glyphs for map labels | OFL 1.1 | long, not immutable |
| `pov/<date>-<v>/countries-patch.json` | India-POV replacement geometries for the choropleth, keyed the way the app keys world-atlas features | CC BY 4.0 (Kalapani via DataMeet); rest public domain | immutable (versioned path) |
| `pov/<date>-<v>/claim-lines.json` | India's official boundary where no de-facto boundary carries it | CC BY 4.0 (Kalapani via DataMeet); rest public domain | immutable (versioned path) |
| `pov/<date>-<v>/disputed-lines.json` | Disputed OSM segments Indian maps do draw, re-extracted from the tiles | **ODbL 1.0** | immutable (versioned path) |

The two line files are separate because their halves carry different licences. Merging them — as
this pipeline used to — makes the whole overlay ODbL, so nobody who cannot take share-alike can
reuse `claim-lines.json`. Every output file carries `licence` and `attribution` at the top level,
and the two line files per feature too.

## Versioning

Two independent pins, both in `src/config.ts`, both mirrored in the app's `src/lib/map-assets.ts`.
Each must move together with its counterpart:

| Pin | Covers | Bump when |
| --- | --- | --- |
| `BASEMAP_BUILD_DATE` | `basemap-<date>.pmtiles` and the `pov/` prefix | pointing at a newer Protomaps planet build |
| `POV_DATA_VERSION` | the `pov/` prefix only | the bytes under `pov/` change for any other reason |

They are separate because they move for different reasons. `pov/*` is served with a one-year
immutable edge **and browser** TTL, so shipping a POV fix under an unchanged path leaves every
returning browser on the old data until the TTL expires. Without the second pin the only options
would be re-fetching a 178MB extract that did not need to change, or purging the CDN and still not
reaching cached browsers. A POV-only change is `POV_DATA_VERSION`, `bun run generate`,
`bun run deploy pov` — no basemap traffic at all.

v1 was the unsuffixed `pov/<date>/` path, before this split existed.

## India point-of-view data

There are two kinds of boundary line — where control sits on the ground today (*de facto*), and a
country's official boundary. Around India they diverge: Pakistan has occupied parts of Jammu and
Kashmir and Ladakh since 1947, behind what is now the Line of Control; China has occupied Aksai
Chin, in Ladakh, since 1962; Pakistan ceded the Shaksgam valley, also part of Ladakh, to China in
1963, a transfer India does not recognise; China claims Arunachal Pradesh, and Nepal claims the
Limpiyadhura–Lipulekh–Kalapani area of Uttarakhand's Pithoragarh district — claims India rejects.

Almost all global map data ships de facto — OSM's mapping policy is explicitly ground-truth-only.
Maps published in India must instead show India's official boundary (Criminal Law (Amendment) Act
1961 §2; the Feb 2021 Geospatial Guidelines liberalised most geospatial activity for Indian
entities but retained boundary depiction per Survey of India). So the tiles ship the stock OSM
worldview and the dashboard renders India's official depiction over it. The corrections are data
generated here and applied by the app at render time; nothing is baked into the tiles.

> Matches India's official depiction. Not derived from, affiliated with, or verified against the
> Survey of India.

That wording is deliberate and should not be loosened. The ground truth here is Natural Earth's
per-worldview attribution plus one LSIB polygon — third-party cartographers' approximations of
India's official boundary, not Survey of India products, and never checked against one. SoI does
not publish its boundary as GeoJSON or through a public API; its external boundary is released as a
shapefile on indiamaps.gov.in without explicit redistribution terms, and its Open Series topo
sheets are issued as watermarked PDFs to registered users. None of it is licensed for republishing
in this form, which is why this pipeline does not use it and must not claim it. openstreetmap.in
applies a comparable correction in its own tileserver import; that is prior art, not a legal basis.

The code is MIT ([LICENSE](LICENSE)). The data it builds is not covered by that: each artifact
carries its sources' licence, per the table above — Natural Earth is public domain, DataMeet's
Kalapani polygon is CC BY 4.0 (DataMeet's repo-wide default; the CC-0 in their Country README covers
only `india-composite.geojson`), and the OSM-derived files are ODbL with
`© OpenStreetMap contributors`.

### How the correction is expressed

A **worldview** is one country's official depiction of contested territory — Natural Earth
publishes 31 of them. `ne_10m_admin_0_disputed_areas` carries one polygon per contested territory
with an `ADM0_A3_<XX>` column per worldview, so filtering on `ADM0_A3_IN` yields exactly the
territory India's maps show as Indian, as **named, individually attributed regions**:

```
Jammu and Kashmir  Aksai Chin       Arunachal Pradesh  Shaksgam Valley  Gilgit-Baltistan
Near Om Parvat     Demchok          Samdu Valleys      Tirpani Valleys  Bara Hotii Valleys
Siachen Glacier    Junagadh and Manavadar              Pakistan-occupied Kashmir
Kalapani  (LSIB via DataMeet, CC BY 4.0 — the one area Natural Earth does not model)
```

Names are Natural Earth's except for B06 and B09, which follow Indian usage: Shaksgam Valley and
Pakistan-occupied Kashmir.

Their union is identical to `ne_10m_admin_0_countries_ind` minus the de-facto file (116,310 km²
either way, symmetric difference empty), so nothing is lost by using them — but they carry names,
which the merged outline does not.

The correction is then applied by **set difference**, not by patching a window: India gains each
region, and each de-facto country loses exactly the same polygon. Both sides are cut by one
geometry, so they share a seam and no gap or overlap can open between them, and the correction
reaches wherever a region sits. An earlier version patched a hardcoded Kashmir bounding box and
therefore silently left Kalapani — outside it on both axes — uncorrected however good the source.

The regions are first clipped to the union of the parties' own base geometry. Natural Earth 10m and
world-atlas disagree about any given border by a couple of kilometres, so unclipped regions eat
slivers of Afghanistan along the Gilgit-Baltistan frontier (measured: 229 km² at 110m, 55 km² at
50m) and float off the base's coastline. Clipped, the union of the patched shapes equals the union
of the base shapes: no area created or destroyed, only reassigned.

### Outputs

- **`countries-patch.json`** — replacement geometries for every country the correction touches
  (India, Pakistan, China, Nepal, and world-atlas's separate `Siachen Glacier` feature). The app's
  activity choropleth swaps these in.
- **`claim-lines.json`** — India's official boundary around each region, minus everything already
  drawn. A segment is dropped when it is shared with an adjacent region (this is what removes the
  Line of Control and the LAC — they lie inside India's official boundary), when it coincides with a
  de-facto country ring, or when it lies inside India's de-facto territory (an internal
  administrative line, e.g. the southern edge of J&K). CC BY 4.0 for the Kalapani feature, public
  domain for the rest.
- **`disputed-lines.json`** — the app's live map hides every `disputed`-flagged OSM boundary
  segment; this file puts back the ones official Indian maps do draw (Jammu International Border,
  middle sector, McMahon line) plus every disputed line outside the India zone (Crimea, Western
  Sahara, ...), re-extracted verbatim from the tiles so they reconnect exactly with the visible
  borders. ODbL 1.0.

  Classification rule: a disputed segment is kept if it lies outside the correction zone (derived
  from the regions' bounding box plus 5°, not hardcoded), or coincides within ~4 km with a boundary
  India recognises — India's official outline, or any de-facto country ring belonging to a country
  that is not party to these disputes. The party rings are exactly the ones carrying the LoC, the
  LAC and the 1963 Pakistan–China line.

Net effect — hidden: the Line of Control, the LAC around Aksai Chin, the 1963 Pakistan–China line,
and the de-facto outline around the Siachen Glacier. Drawn: everything else plus India's official
outer boundary.

Expected `generate` output (sanity numbers): India +118,800 km² (+3.8%), Pakistan −77,000 km²
(−8.8%), China −39,700 km² (−0.4%), Siachen Glacier −99%; 5 claim-line features; ~120 raw / ~130
kept disputed lines; 14/14 conformance. Large deviations mean upstream data changed in a way worth
inspecting.

## Prerequisites

- [bun](https://bun.sh)
- `pmtiles` CLI (go-pmtiles) for the basemap extract — `brew install pmtiles` or
  https://github.com/protomaps/go-pmtiles/releases. The extract uses HTTP range requests; only
  the low-zoom tiles are downloaded, not the ~120GB planet.

## Hosting (R2 + Cloudflare CDN)

- **Bucket**: R2, fronted by a custom domain (`maps.<domain>`) on the Cloudflare zone.
- **Range requests**: PMTiles is read via HTTP `Range` requests; R2 honours them, and the CDN
  must not strip them.
- **CORS** on the bucket: allow `GET`/`HEAD` from the app origins, accept the `Range` header,
  expose `Content-Range`/`Content-Length`/`ETag`:

  ```json
  [
    {
      "AllowedOrigins": ["https://app.example.com", "http://localhost:5173"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range", "If-Match"],
      "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"],
      "MaxAgeSeconds": 86400
    }
  ]
  ```

- **Cache Rules** (on the CDN zone — object metadata is not used; the deploy uploads no
  `Cache-Control`, so these rules are the *only* thing that makes anything cacheable). Each rule
  must set **Cache eligibility → Eligible for cache** plus **Edge TTL** and **Browser TTL →
  Override origin** — the Browser TTL override is what injects `Cache-Control` for the browser,
  so no object metadata is needed. Match on `http.host eq "maps.<domain>"` and the path prefix:
  - `basemap-*.pmtiles`, `pov/*`: eligible for cache, edge + browser TTL 1 year (paths are versioned
    — see [Versioning](#versioning); a POV change that does not move `POV_DATA_VERSION` will not
    reach anyone for a year).
  - `fonts/*`: eligible for cache, edge + browser TTL 1 day.

  Cache-size cap — Cloudflare's **512MiB max cacheable object size** on Free/Pro/Business plans
  (only Enterprise raises it, 5GB default) applies to the whole `.pmtiles`. The z0–z8 extract was
  ~522MiB, ~10MiB over, so it never edge-cached (`cf-cache-status: BYPASS`): every `Range` request
  the pmtiles reader makes (header → directory → leaf dir → each tile) round-tripped to R2 origin,
  which is what made the map load slowly with tiles trickling in. Capping the extract at **z7**
  (`MAXZOOM` in `src/config.ts`) brings it to ~270MiB so the archive edge-caches as a whole and
  range requests hit the edge; the dashboard still runs to z8 via MapLibre overzoom. If z8 source
  detail is ever needed back, keep z8 and put a per-tile caching Worker in front of R2 instead (the
  per-tile responses are tiny and always cacheable). The pmtiles is read via `Range` requests, so
  verify cache status with a real GET (`curl -o /dev/null -D -`), not `curl -I` — HEAD always
  reports `DYNAMIC`.

- **Deploy credentials**: an R2 API token with write access to the bucket, supplied as env vars
  (`.env` works):

  ```
  R2_ACCOUNT_ID=...
  R2_ACCESS_KEY_ID=...
  R2_SECRET_ACCESS_KEY=...
  R2_BUCKET=pug-maps
  ```

The app reads `VITE_MAP_ASSETS_URL` and falls back to its own origin when the value is empty.

**`bun run sync:app` alone is not enough to test locally.** The app's committed `.env` pins
`VITE_MAP_ASSETS_URL=https://maps.<domain>` for dev as well as prod, so it loads map assets from
the CDN and never looks at the files sync:app just wired into its `public/`. To test POV data that
has not been deployed yet, blank the variable in the app's `.env.local` (gitignored, and it takes
precedence over `.env`):

```
VITE_MAP_ASSETS_URL=
```

Without that override the symptom is specifically confusing: the basemap and fonts still render —
they are deployed — while a bumped `POV_DATA_VERSION` points at a prefix that only exists locally,
so every boundary overlay silently vanishes and the map looks broken rather than misconfigured.

## Bumping the basemap

1. Bump `BASEMAP_BUILD_DATE` in `src/config.ts` (this moves the `pov/` prefix too).
2. `bun run build` — fetches the new extract and regenerates the POV data against it. It fails if
   the conformance harness does; a failure here means the upstream data moved, not that the build
   is flaky.
3. Eyeball the line rendering (see verification below).
4. `bun run deploy` — uploads the new versioned artifacts (the old version stays until you
   delete it; nothing cached breaks).
5. Bump `BASEMAP_BUILD_DATE` in the app's `src/lib/map-assets.ts`, `bun run sync:app`, verify
   locally, deploy the app.
6. Delete the old `basemap-<date>.pmtiles` and `pov/<date>-<v>/` from the bucket once the app
   deploy has settled.

Fonts only need re-uploading if the protomaps-themes-base font stacks ever change.

## Shipping a POV-only change

No basemap traffic, same ordering rule — the data has to be in the bucket before the app asks for it.

1. Bump `POV_DATA_VERSION` in `src/config.ts`.
2. `bun run generate` — regenerates under the new prefix and runs the harness.
3. `bun run deploy pov`.
4. Bump `POV_DATA_VERSION` in the app's `src/lib/map-assets.ts`, `bun run sync:app`, verify
   locally, deploy the app.
5. Delete the old `pov/<date>-<v>/` from the bucket once the app deploy has settled.

Deploying the app first means it requests a prefix that is not there yet. Both line files fail soft
(console warning, missing lines) and the choropleth falls back to de-facto shapes, so the symptom
looks like a rendering bug rather than a 404 — worth knowing before you go looking in the wrong
place.

## Verifying the POV data

`bun run generate` runs a conformance harness over the **built** choropleth — the world-atlas base
with `countries-patch.json` applied, exactly as the app assembles it — and exits non-zero on any
miss. `bun run verify` re-runs it against whatever is in `dist/` without rebuilding.

Fourteen named places, each with the owner India's depiction gives it, in `src/conformance.ts`:
Gilgit, Muzaffarabad, Aksai Chin, Shaksgam, Siachen, Demchok, Kalapani, Lipulekh, Limpiyadhura,
Tawang, Walong; and Lahore/Kashgar/Colombo as negative controls the correction must leave alone. A
point owned by *two* countries fails as loudly as a point owned by the wrong one — that is the
check that catches a seam opening between a patched pair.

It has to run against the built artifact, not the source: some defects live in the base rather than
in the POV data. Tawang rendered as Bhutan at 110m, and no source-level check would ever have seen
it.

Then eyeball in the app (`bun run sync:app`, then `bun run dev` in the app) — the harness cannot
see line rendering:

- Live map (`/live`): Jammu sector — the Jammu International Border connects the Punjab border to
  India's official western J&K boundary with no gap; Gilgit-Baltistan and Aksai Chin sit inside
  India's boundary with no Line of Control drawn through Kashmir; no boundary is drawn around the
  Siachen Glacier; the McMahon line renders along Arunachal Pradesh. Check light and dark themes.
- Overview activity map: the India fill/hover covers all of J&K.
- Spot-check that disputed lines outside the correction zone (Western Sahara, Crimea) still render.
