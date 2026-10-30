/**
 * The reach display: isolines at the band edges plus a soft area fill, both
 * computed client-side from the Worker's min-time grids, at every zoom.
 *
 * Two detail levels ({@link ISO_LEVELS}): a 1 km grid for the country view and a
 * 250 m grid from region scale in. Each grid is smoothed first -- a min filter
 * closes the gaps between roads (up to the level's `gapKm`, with an off-road
 * penalty per km), then a masked box blur softens the cell steps -- and
 * marching squares traces each band edge. The fine level closes smaller gaps,
 * so its area hugs the roads. The fill is the same smoothed field, banded and
 * painted into an RGBA image that MapLibre drapes over the grid's bbox.
 *
 * Times are *displayed* minutes: Worker minutes plus the leg offset, divided by
 * the rider's speed factor, so isolines move with the speed slider for free.
 */

import { BAND_COLORS, N_BANDS, bandStepS } from './colorScale.ts';
import { GRID_NONE, type EffortGrid } from './effortResponse.ts';

const INF = Number.POSITIVE_INFINITY;

export interface IsoLevel {
  /** Grid cell size the Worker is asked for, km. */
  readonly cellKm: number;
  /** How far a reached road "fills" towards roadless cells, km. */
  readonly gapKm: number;
  /** Zoom range the level shows in (MapLibre layer minzoom / maxzoom). */
  readonly minzoom: number;
  readonly maxzoom: number;
}

/** Coarse to fine; the zoom ranges meet, so exactly one level shows at a time. */
export const ISO_LEVELS: readonly IsoLevel[] = [
  { cellKm: 1, gapKm: 1, minzoom: 0, maxzoom: 9 },
  { cellKm: 0.25, gapKm: 0.5, minzoom: 9, maxzoom: 24 },
];

/** Extra minutes per km charged for that fill: it is not a road you ride. */
const GAP_PENALTY_MIN_PER_KM = 4;
const BLUR_RADIUS = 1;
const MIN_WEIGHT = 0.3;
const KM_PER_DEG_LAT = 110.54;

/** Displayed minutes per cell, smoothed; Infinity where nothing is reached. */
export function smoothField(grid: EffortGrid, offsetMin: number, factor: number, gapKm = 1): Float32Array {
  const { nx, ny, minutes } = grid;
  const raw = new Float32Array(nx * ny);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = minutes[i] === GRID_NONE ? INF : (minutes[i] + offsetMin) / factor;
  }
  // Min filter over a disc of gapKm, charging the off-road distance. Flat
  // typed arrays: this loop runs (disc size) times per cell.
  const cellKm = grid.cellLatDeg * KM_PER_DEG_LAT;
  const r = Math.max(1, Math.round(gapKm / cellKm));
  const ox: number[] = [];
  const oy: number[] = [];
  const op: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r + 0.5) continue;
      ox.push(dx);
      oy.push(dy);
      op.push(d * cellKm * GAP_PENALTY_MIN_PER_KM);
    }
  }
  const offX = Int32Array.from(ox);
  const offY = Int32Array.from(oy);
  const offPen = Float32Array.from(op);
  const filled = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let m = INF;
      for (let k = 0; k < offX.length; k++) {
        const xx = x + offX[k];
        const yy = y + offY[k];
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const v = raw[yy * nx + xx] + offPen[k];
        if (v < m) m = v;
      }
      filled[y * nx + x] = m;
    }
  }
  // Masked separable box blur: average only over reached cells.
  let val: Float32Array = new Float32Array(nx * ny);
  let wt: Float32Array = new Float32Array(nx * ny);
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] < INF) {
      val[i] = filled[i];
      wt[i] = 1;
    }
  }
  const R = BLUR_RADIUS;
  const passH = (v: Float32Array, w: Float32Array): [Float32Array, Float32Array] => {
    const v2 = new Float32Array(nx * ny);
    const w2 = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let sv = 0;
        let sw = 0;
        for (let d = -R; d <= R; d++) {
          const xx = x + d;
          if (xx < 0 || xx >= nx) continue;
          sv += v[y * nx + xx];
          sw += w[y * nx + xx];
        }
        v2[y * nx + x] = sv;
        w2[y * nx + x] = sw;
      }
    }
    return [v2, w2];
  };
  const passV = (v: Float32Array, w: Float32Array): [Float32Array, Float32Array] => {
    const v2 = new Float32Array(nx * ny);
    const w2 = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let sv = 0;
        let sw = 0;
        for (let d = -R; d <= R; d++) {
          const yy = y + d;
          if (yy < 0 || yy >= ny) continue;
          sv += v[yy * nx + x];
          sw += w[yy * nx + x];
        }
        v2[y * nx + x] = sv;
        w2[y * nx + x] = sw;
      }
    }
    return [v2, w2];
  };
  [val, wt] = passH(val, wt);
  [val, wt] = passV(val, wt);
  const n = (2 * R + 1) ** 2;
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < out.length; i++) out[i] = wt[i] / n > MIN_WEIGHT ? val[i] / wt[i] : INF;
  return out;
}

/** Cell centre (x, y in grid units, may be fractional) -> [lon, lat]. */
function toLonLat(grid: EffortGrid, gx: number, gy: number): [number, number] {
  return [grid.westLon + (gx + 0.5) * grid.cellLonDeg, grid.northLat - (gy + 0.5) * grid.cellLatDeg];
}

/** Cell value for contouring: unreached counts as "above" every level, so lines close at the reach edge. */
function levelValue(field: Float32Array, i: number, level: number): number {
  const t = field[i];
  return t === INF ? level + 1e4 : t;
}

/**
 * Marching squares at `level` minutes. Returns each segment as a pair of crossed
 * grid edges: `2 * cell` is the edge from that cell's corner east, `2 * cell + 1`
 * the edge south. Neighbouring cells name a shared edge alike, which is what
 * lets {@link contourLines} join the segments.
 */
function crossedEdges(field: Float32Array, nx: number, ny: number, level: number): number[] {
  const edges: number[] = [];
  for (let y = 0; y < ny - 1; y++) {
    for (let x = 0; x < nx - 1; x++) {
      const i = y * nx + x;
      const a = levelValue(field, i, level);
      const b = levelValue(field, i + 1, level);
      const c = levelValue(field, i + nx + 1, level);
      const d = levelValue(field, i + nx, level);
      const idx = (a < level ? 8 : 0) | (b < level ? 4 : 0) | (c < level ? 2 : 0) | (d < level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = 2 * i;
      const B = 2 * (i + nx);
      const L = 2 * i + 1;
      const Rt = 2 * (i + 1) + 1;
      switch (idx) {
        case 1: case 14: edges.push(L, B); break;
        case 2: case 13: edges.push(B, Rt); break;
        case 3: case 12: edges.push(L, Rt); break;
        case 4: case 11: edges.push(T, Rt); break;
        case 5: edges.push(L, T, B, Rt); break;
        case 6: case 9: edges.push(T, B); break;
        case 7: case 8: edges.push(L, T); break;
        case 10: edges.push(T, Rt, L, B); break;
      }
    }
  }
  return edges;
}

/** Where `level` crosses grid edge `e` (see {@link crossedEdges}), in grid units. */
function edgePoint(field: Float32Array, nx: number, level: number, e: number): [number, number] {
  const i = e >> 1;
  const x = i % nx;
  const y = (i - x) / nx;
  const a = levelValue(field, i, level);
  if ((e & 1) === 0) return [x + (level - a) / (levelValue(field, i + 1, level) - a), y];
  return [x, y + (level - a) / (levelValue(field, i + nx, level) - a)];
}

/** Marching squares at `level` minutes as loose 2-point segments, flat x, y in grid units. */
export function contourSegments(field: Float32Array, nx: number, ny: number, level: number): number[] {
  const segs: number[] = [];
  for (const e of crossedEdges(field, nx, ny, level)) segs.push(...edgePoint(field, nx, level, e));
  return segs;
}

/**
 * Marching squares at `level` minutes, joined into polylines (flat x, y in grid
 * units). A closed ring comes back with its first point repeated at the end.
 */
export function contourLines(field: Float32Array, nx: number, ny: number, level: number): number[][] {
  const edges = crossedEdges(field, nx, ny, level);
  const nSeg = edges.length / 2;
  // A crossed edge is shared by at most two segments, one from each cell beside it.
  const segsAt = new Map<number, number[]>();
  for (let k = 0; k < edges.length; k++) {
    const list = segsAt.get(edges[k]);
    if (list === undefined) segsAt.set(edges[k], [k >> 1]);
    else list.push(k >> 1);
  }
  const used = new Uint8Array(nSeg);
  // Leave edge `e` through its unused segment: that segment's far edge, or -1.
  const next = (e: number): number => {
    for (const s of segsAt.get(e)!) {
      if (used[s] === 1) continue;
      used[s] = 1;
      return edges[2 * s] === e ? edges[2 * s + 1] : edges[2 * s];
    }
    return -1;
  };
  const lines: number[][] = [];
  for (let s = 0; s < nSeg; s++) {
    if (used[s] === 1) continue;
    used[s] = 1;
    const ahead = [edges[2 * s], edges[2 * s + 1]];
    for (let e = next(ahead[1]); e !== -1; e = next(e)) ahead.push(e);
    const behind: number[] = [];
    for (let e = next(ahead[0]); e !== -1; e = next(e)) behind.push(e);
    const pts: number[] = [];
    for (const e of behind.reverse().concat(ahead)) pts.push(...edgePoint(field, nx, level, e));
    lines.push(pts);
  }
  return lines;
}

export interface IsolineFeature {
  readonly type: 'Feature';
  readonly properties: { readonly band: number; readonly minutes: number; readonly color: string; readonly last: boolean };
  readonly geometry: { readonly type: 'MultiLineString'; readonly coordinates: Array<Array<[number, number]>> };
}

/** One MultiLineString per band edge within the budget. */
export function isolines(
  grid: EffortGrid,
  field: Float32Array,
  budgetHours: number,
): { type: 'FeatureCollection'; features: IsolineFeature[] } {
  const stepMin = bandStepS(budgetHours) / 60;
  const budgetMin = budgetHours * 60;
  const features: IsolineFeature[] = [];
  for (let k = 1; k <= N_BANDS; k++) {
    const level = Math.min(k * stepMin, budgetMin);
    const lines = contourLines(field, grid.nx, grid.ny, level).map((pts) => {
      const line: Array<[number, number]> = [];
      for (let i = 0; i < pts.length; i += 2) line.push(toLonLat(grid, pts[i], pts[i + 1]));
      return line;
    });
    const last = level >= budgetMin;
    features.push({
      type: 'Feature',
      properties: { band: k - 1, minutes: level, color: BAND_COLORS[k - 1], last },
      geometry: { type: 'MultiLineString', coordinates: lines },
    });
    if (last) break;
  }
  return { type: 'FeatureCollection', features };
}

/** Banded RGBA fill of the smoothed field, one pixel per cell, north row first. */
export function fillImage(field: Float32Array, nx: number, ny: number, budgetHours: number): ImageData {
  const img = new ImageData(nx, ny);
  const step = bandStepS(budgetHours) / 60;
  const budgetMin = budgetHours * 60;
  const rgb = BAND_COLORS.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  for (let i = 0; i < field.length; i++) {
    const t = field[i];
    if (!(t < budgetMin)) continue;
    const c = rgb[Math.min(N_BANDS - 1, Math.floor(t / step))];
    img.data[4 * i] = c[0];
    img.data[4 * i + 1] = c[1];
    img.data[4 * i + 2] = c[2];
    img.data[4 * i + 3] = 255;
  }
  return img;
}

/** The grid's outer corners for a MapLibre image source: NW, NE, SE, SW. */
export function gridCorners(grid: EffortGrid): [[number, number], [number, number], [number, number], [number, number]] {
  const e = grid.westLon + grid.nx * grid.cellLonDeg;
  const s = grid.northLat - grid.ny * grid.cellLatDeg;
  return [[grid.westLon, grid.northLat], [e, grid.northLat], [e, s], [grid.westLon, s]];
}
