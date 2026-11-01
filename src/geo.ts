// Geometry primitives shared by the POV builder and the conformance harness.
//
// Everything works on plain GeoJSON coordinate arrays. Distances are planar degrees except where
// a function says otherwise — fine at this latitude band, and the only place real area matters is
// the human-readable reporting.

import type { MultiPolygon, Polygon, Position } from 'geojson'
import polygonClipping from 'polygon-clipping'

export type Ring = Position[]
export type Poly = Ring[]
export type MultiPoly = Poly[]

// polygon-clipping types coordinates as [number, number] pairs; ours are geojson Positions
// (number[]) — identical at runtime.
type ClipGeom = Parameters<typeof polygonClipping.difference>[0]

export const union = (...mps: MultiPoly[]): MultiPoly =>
  mps.length === 0 ? [] : (polygonClipping.union(mps[0] as ClipGeom, ...(mps.slice(1) as ClipGeom[])) as MultiPoly)

export const intersection = (a: MultiPoly, b: MultiPoly): MultiPoly =>
  polygonClipping.intersection(a as ClipGeom, b as ClipGeom) as MultiPoly

export const difference = (a: MultiPoly, b: MultiPoly): MultiPoly =>
  polygonClipping.difference(a as ClipGeom, b as ClipGeom) as MultiPoly

export const asMultiPoly = (geom: Polygon | MultiPolygon): MultiPoly =>
  geom.type === 'Polygon' ? [geom.coordinates as Poly] : (geom.coordinates as MultiPoly)

export const toMultiPolygon = (mp: MultiPoly): MultiPolygon => ({ type: 'MultiPolygon', coordinates: mp })

// --- Douglas-Peucker simplification (planar, fine for this latitude band) ---

export const perpDist = (p: Position, a: Position, b: Position) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  const cx = a[0] + Math.max(0, Math.min(1, t)) * dx
  const cy = a[1] + Math.max(0, Math.min(1, t)) * dy
  return Math.hypot(p[0] - cx, p[1] - cy)
}

export const simplifyRing = (ring: Ring, tolerance: number): Ring => {
  if (ring.length <= 4) return ring
  const keep = new Array(ring.length).fill(false)
  keep[0] = keep[ring.length - 1] = true
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop() as [number, number]
    let maxD = 0
    let maxI = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(ring[i], ring[lo], ring[hi])
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > tolerance) {
      keep[maxI] = true
      stack.push([lo, maxI], [maxI, hi])
    }
  }
  const out = ring.filter((_, i) => keep[i])
  return out.length >= 4 ? out : ring
}

export const simplify = (mp: MultiPoly, tolerance: number): MultiPoly =>
  mp
    .map(poly => poly.map(ring => simplifyRing(ring, tolerance)).filter(ring => ring.length >= 4))
    .filter(poly => poly.length > 0)

export const roundCoord = ([x, y]: Position): Position => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]

export const round = (mp: MultiPoly): MultiPoly => mp.map(poly => poly.map(ring => ring.map(roundCoord)))

export const vertexCount = (mp: MultiPoly) => mp.reduce((n, poly) => n + poly.reduce((m, r) => m + r.length, 0), 0)

// --- Measurement ---

const EARTH_RADIUS_KM = 6371.0088
const RAD = Math.PI / 180

/**
 * Signed spherical area of a ring in km², by the standard spherical-excess sum. A planar
 * approximation is not good enough here: several of the shapes measured span 30° of latitude, and
 * a cos(mean latitude) correction gets their area wrong by enough to reverse the sign of a delta.
 */
const ringAreaKm2 = (ring: Ring) => {
  let total = 0
  for (let i = 1; i < ring.length; i++) {
    const [lon1, lat1] = ring[i - 1]
    const [lon2, lat2] = ring[i]
    total += (lon2 - lon1) * RAD * (2 + Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD))
  }
  return (total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2
}

/** Area in km², outer rings minus holes. */
export const areaKm2 = (mp: MultiPoly) => {
  let total = 0
  for (const poly of mp) {
    if (!poly.length) continue
    let a = Math.abs(ringAreaKm2(poly[0]))
    for (let i = 1; i < poly.length; i++) a -= Math.abs(ringAreaKm2(poly[i]))
    total += a
  }
  return total
}

// --- Point location ---

const inRing = (p: Position, ring: Ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Ray-casting containment, honouring holes. */
export const contains = (mp: MultiPoly, p: Position) => {
  for (const poly of mp) {
    if (!inRing(p, poly[0])) continue
    let inHole = false
    for (let i = 1; i < poly.length; i++) if (inRing(p, poly[i])) inHole = true
    if (!inHole) return true
  }
  return false
}
