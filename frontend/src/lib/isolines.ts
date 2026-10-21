/**
 * Reach display up to region scale: isolines at the band edges plus a soft area
 * fill, both computed client-side from the Worker's min-time grid (500 m cells).
 *
 * From country down to region scale a surface reads better than single roads.
 * The grid is smoothed first -- a min filter closes the gaps between roads
 * (~{@link GAP_REACH_KM}, with an off-road penalty per km), then a masked box
 * blur softens the cell steps -- and marching squares traces each band edge.
 * The filter reach and penalty are in km, so a change of grid size keeps the
 * look. The fill is the same smoothed field, banded and painted into an
 * RGBA image that MapLibre drapes over the grid's bbox.
 *
 * Times are *displayed* minutes: Worker minutes plus the leg offset, divided by
 * the rider's speed factor, so isolines move with the speed slider for free.
 */

import { BAND_COLORS, N_BANDS, bandStepS } from './colorScale.ts';
import { GRID_NONE, type EffortGrid } from './effortResponse.ts';

const INF = Number.POSITIVE_INFINITY;
/** How far a reached road "fills" towards roadless cells, km. */
const GAP_REACH_KM = 1;
/** Extra minutes per km charged for that fill: it is not a road you ride. */
const GAP_PENALTY_MIN_PER_KM = 4;
const BLUR_RADIUS = 1;
const MIN_WEIGHT = 0.3;
const KM_PER_DEG_LAT = 110.54;

/** Displayed minutes per cell, smoothed; Infinity where nothing is reached. */
export function smoothField(grid: EffortGrid, offsetMin: number, factor: number): Float32Array {
  const { nx, ny, minutes } = grid;
  const raw = new Float32Array(nx * ny);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = minutes[i] === GRID_NONE ? INF : (minutes[i] + offsetMin) / factor;
  }
  // Min filter over a disc of GAP_REACH_KM, charging the off-road distance.
  const cellKm = grid.cellLatDeg * KM_PER_DEG_LAT;
  const r = Math.max(1, Math.round(GAP_REACH_KM / cellKm));
  const offsets: Array<[number, number, number]> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= r + 0.5) offsets.push([dx, dy, d * cellKm * GAP_PENALTY_MIN_PER_KM]);
    }
  }
  const filled = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let m = INF;
      for (const [dx, dy, pen] of offsets) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const v = raw[yy * nx + xx] + pen;
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

/**
 * Marching squares at `level` minutes. Returns 2-point segments in grid units;
 * unreached cells count as "above" every level so lines close at the reach edge.
 */
export function contourSegments(field: Float32Array, nx: number, ny: number, level: number): number[] {
  const segs: number[] = [];
  const v = (x: number, y: number): number => {
    const t = field[y * nx + x];
    return t === INF ? level + 1e4 : t;
  };
  for (let y = 0; y < ny - 1; y++) {
    for (let x = 0; x < nx - 1; x++) {
      const a = v(x, y);
      const b = v(x + 1, y);
      const c = v(x + 1, y + 1);
      const d = v(x, y + 1);
      const idx = (a < level ? 8 : 0) | (b < level ? 4 : 0) | (c < level ? 2 : 0) | (d < level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const f = (p: number, q: number): number => (level - p) / (q - p);
      const T = [x + f(a, b), y];
      const Rt = [x + 1, y + f(b, c)];
      const B = [x + f(d, c), y + 1];
      const L = [x, y + f(a, d)];
      const add = (p: number[], q: number[]): void => {
        segs.push(p[0], p[1], q[0], q[1]);
      };
      switch (idx) {
        case 1: case 14: add(L, B); break;
        case 2: case 13: add(B, Rt); break;
        case 3: case 12: add(L, Rt); break;
        case 4: case 11: add(T, Rt); break;
        case 5: add(L, T); add(B, Rt); break;
        case 6: case 9: add(T, B); break;
        case 7: case 8: add(L, T); break;
        case 10: add(T, Rt); add(L, B); break;
      }
    }
  }
  return segs;
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
    const segs = contourSegments(field, grid.nx, grid.ny, level);
    const lines: Array<Array<[number, number]>> = [];
    for (let i = 0; i < segs.length; i += 4) {
      lines.push([toLonLat(grid, segs[i], segs[i + 1]), toLonLat(grid, segs[i + 2], segs[i + 3])]);
    }
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
