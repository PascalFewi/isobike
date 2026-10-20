/**
 * Wire protocol for the Worker API: request parsing, cost-model resolution, and
 * the `/effort-field` binary response.
 *
 * Pure and free of any Worker/Cloudflare or router-search dependency, so vitest
 * drives every function directly. `handlers.ts` composes these with the router.
 *
 * Units. Speeds are **m/s** on the wire, exactly as the spec states -- the
 * frontend converts km/h and Hm/h before sending. Budgets and times are
 * **seconds**.
 */

import { SURFACE_CLASS_COUNT, type Graph } from './binformat.js';
import { distanceEquivModel, timeModel, type CostModel } from './router.js';

/** Default effort-field budget: 8 hours, in seconds. Profile-independent. */
export const DEFAULT_BUDGET_S = 8 * 3600;

/** The only metric implemented in v1. The field exists so `minimax` can be added
 * later without an API break -- see {@link resolveMetric}. */
export const SUPPORTED_METRICS = ['time'] as const;
export type Metric = (typeof SUPPORTED_METRICS)[number];

/** A request was malformed; the handler turns this into an HTTP 4xx with a body. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// --------------------------------------------------------------------------- //
// Small validation helpers
// --------------------------------------------------------------------------- //

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(`${field} must be a finite number`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireFiniteNumber(value, field);
}

function requireLatLon(value: unknown, field: string): [number, number] {
  // Accept both {lat, lon} and [lat, lon]; the frontend uses objects, tests use
  // whichever is terser.
  let lat: number;
  let lon: number;
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new ApiError(`${field} array must be [lat, lon]`);
    lat = requireFiniteNumber(value[0], `${field} lat`);
    lon = requireFiniteNumber(value[1], `${field} lon`);
  } else {
    const obj = asObject(value);
    lat = requireFiniteNumber(obj.lat, `${field}.lat`);
    lon = requireFiniteNumber(obj.lon, `${field}.lon`);
  }
  if (lat < -90 || lat > 90) throw new ApiError(`${field} lat ${lat} out of range [-90, 90]`);
  if (lon < -180 || lon > 180) throw new ApiError(`${field} lon ${lon} out of range [-180, 180]`);
  return [lat, lon];
}

// --------------------------------------------------------------------------- //
// Cost-model resolution (shared by /effort-field and /route)
// --------------------------------------------------------------------------- //

/**
 * Internal fallback α → climb_factor: `cf = 8·α/(1−α)`, capped at 200.
 *
 * Not the UI abstraction any more -- the frontend sends (v_flat, vam). This only
 * fires when a caller supplies `alpha` and no profile, and yields a
 * distance-equivalent cost (metres), not seconds. See the spec's fallback note.
 */
export function alphaToClimbFactor(alpha: number): number {
  if (alpha < 0) throw new ApiError(`alpha ${alpha} must be >= 0`);
  if (alpha >= 1) return 200;
  return Math.min(200, (8 * alpha) / (1 - alpha));
}

export function resolveMetric(value: unknown): Metric {
  if (value === undefined || value === null) return 'time';
  if (typeof value !== 'string' || !(SUPPORTED_METRICS as readonly string[]).includes(value)) {
    // The seam for a future bottleneck-shortest-path metric: add it to
    // SUPPORTED_METRICS and branch in resolveCostModel / the handler, no API break.
    throw new ApiError(`metric must be one of ${SUPPORTED_METRICS.join(', ')}`);
  }
  return value as Metric;
}

/**
 * Build the CostModel from a request body.
 *
 * Primary path: `{v_flat, vam}` in m/s -> the time metric. Fallback: `{alpha}` ->
 * distance-equivalent. Supplying neither, or a non-positive speed, is a 400.
 */
export function resolveCostModel(body: Record<string, unknown>): CostModel {
  resolveMetric(body.metric); // validate even though v1 has one metric

  const vFlat = optionalFiniteNumber(body.v_flat, 'v_flat');
  const vam = optionalFiniteNumber(body.vam, 'vam');

  if (vFlat !== undefined || vam !== undefined) {
    if (vFlat === undefined || vam === undefined) {
      throw new ApiError('v_flat and vam must be provided together (m/s)');
    }
    if (vFlat <= 0 || vam <= 0) throw new ApiError('v_flat and vam must be positive (m/s)');
    return timeModel(vFlat, vam);
  }

  const alpha = optionalFiniteNumber(body.alpha, 'alpha');
  if (alpha !== undefined) return distanceEquivModel(alphaToClimbFactor(alpha));

  throw new ApiError('provide v_flat and vam (m/s), or alpha');
}

function resolveMaxSlope(body: Record<string, unknown>): number | undefined {
  const v = optionalFiniteNumber(body.max_slope, 'max_slope');
  if (v !== undefined && v < 0) throw new ApiError('max_slope must be >= 0');
  return v;
}

/**
 * Parse the optional `surfaces` array (allowed Surface class ids) into a Set.
 *
 * `undefined` when absent -- meaning no surface filter. An explicitly empty array
 * is rejected: it would block every edge, which is never what a caller means and
 * is almost always a client bug.
 */
function resolveSurfaces(body: Record<string, unknown>): ReadonlySet<number> | undefined {
  const raw = body.surfaces;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError('surfaces must be a non-empty array of surface class ids');
  }
  const set = new Set<number>();
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= SURFACE_CLASS_COUNT) {
      throw new ApiError(`surfaces entries must be integers in [0, ${SURFACE_CLASS_COUNT - 1}]`);
    }
    set.add(value);
  }
  return set;
}

// --------------------------------------------------------------------------- //
// Parsed request shapes
// --------------------------------------------------------------------------- //

export interface EffortFieldRequest {
  readonly lat: number;
  readonly lon: number;
  readonly model: CostModel;
  readonly maxSlopePct: number | undefined;
  readonly allowedSurfaces: ReadonlySet<number> | undefined;
  readonly maxCost: number;
  /** Cell size of the optional min-time grid (for isolines), km; undefined = no grid. */
  readonly gridKm: number | undefined;
}

/** Smallest grid cell accepted: finer than ~250 m only costs bytes. */
export const MIN_GRID_KM = 0.25;

export function parseEffortFieldBody(raw: unknown): EffortFieldRequest {
  const body = asObject(raw);
  const [lat, lon] = requireLatLon(body, 'start');
  const model = resolveCostModel(body);
  const maxCost = optionalFiniteNumber(body.max_cost, 'max_cost');
  if (maxCost !== undefined && maxCost <= 0) throw new ApiError('max_cost must be positive (seconds)');
  const gridKm = optionalFiniteNumber(body.grid_km, 'grid_km');
  if (gridKm !== undefined && gridKm < MIN_GRID_KM) throw new ApiError(`grid_km must be >= ${MIN_GRID_KM}`);
  return {
    lat,
    lon,
    model,
    maxSlopePct: resolveMaxSlope(body),
    allowedSurfaces: resolveSurfaces(body),
    maxCost: maxCost ?? DEFAULT_BUDGET_S,
    gridKm,
  };
}

export interface RouteRequest {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly model: CostModel;
  readonly maxSlopePct: number | undefined;
  readonly allowedSurfaces: ReadonlySet<number> | undefined;
}

export function parseRouteBody(raw: unknown): RouteRequest {
  const body = asObject(raw);
  if (body.from === undefined || body.to === undefined) {
    throw new ApiError('route requires from and to coordinates');
  }
  return {
    from: requireLatLon(body.from, 'from'),
    to: requireLatLon(body.to, 'to'),
    model: resolveCostModel(body),
    maxSlopePct: resolveMaxSlope(body),
    allowedSurfaces: resolveSurfaces(body),
  };
}

export function parseSnapQuery(url: URL): { lat: number; lon: number } {
  const latRaw = url.searchParams.get('lat');
  const lonRaw = url.searchParams.get('lon');
  if (latRaw === null || lonRaw === null) throw new ApiError('snap requires lat and lon query params');
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new ApiError('lat and lon must be numbers');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new ApiError('lat/lon out of range');
  return { lat, lon };
}

// --------------------------------------------------------------------------- //
// /effort-field binary response
// --------------------------------------------------------------------------- //
//
// Header (32 bytes, little-endian) then three parallel sections. Struct-of-arrays
// for the same zero-copy reason as graph.bin: the client makes a Uint32Array and
// two Float32Arrays straight over the received ArrayBuffer, no copy, no parse.
//
//   off size type      field
//     0    4  char[4]  magic "VEFF"
//     4    2  u16      format_version (== 2)
//     6    2  u16      header_size (== 32)
//     8    4  u32      count            (number of edges in the field)
//    12    4  u32      snapped_node
//    16    4  f32      snapped_lat      (so the client can place the start marker)
//    20    4  f32      snapped_lon
//    24    4  f32      max_time         (seconds; colour-band scaling, channel 1)
//    28    4  f32      max_cum_ascent   (metres;  colour-band scaling, channel 2)
//    32  4*N  u32[N]   edge_id
//  32+4N 4*N  f32[N]   time
//  32+8N 4*N  f32[N]   cum_ascent
//
// Optional grid trailer (v2, only when the request asked for `grid_km`): the
// minimum reach time per map cell, from which the client draws isolines at low
// zoom without touching a single tile feature.
//
//  32+12N  4  char[4]  magic "VGRD"
//          4  u32      nx               (columns, west -> east)
//          4  u32      ny               (rows, north -> south)
//          4  f32      west_lon         (west edge of column 0)
//          4  f32      north_lat        (north edge of row 0)
//          4  f32      cell_lon_deg
//          4  f32      cell_lat_deg
//          4  --       reserved
//   +32  2*nx*ny u16[] minutes, row-major; 65535 = no reachable road in the cell

export const EFFORT_MAGIC = 'VEFF';
export const EFFORT_FORMAT_VERSION = 2;
export const EFFORT_HEADER_SIZE = 32;
export const GRID_MAGIC = 'VGRD';
export const GRID_HEADER_SIZE = 32;
export const GRID_NONE = 65535;

import type { EffortField } from './router.js';

export interface EffortGrid {
  readonly nx: number;
  readonly ny: number;
  readonly westLon: number;
  readonly northLat: number;
  readonly cellLonDeg: number;
  readonly cellLatDeg: number;
  /** Minutes, row-major north -> south; {@link GRID_NONE} where nothing is reached. */
  readonly minutes: Uint16Array;
}

/** km per degree of latitude; longitude scales by cos(lat). */
const KM_PER_DEG_LAT = 110.54;
const KM_PER_DEG_LON_EQ = 111.32;

/**
 * Minimum reach time per `cellKm` cell over the graph's bbox. Each half-edge
 * counts at its midpoint with its geometric edge's field time; O(E), ~20 ms
 * nationwide.
 */
export function effortGrid(graph: Graph, field: EffortField, cellKm: number): EffortGrid {
  const [minLon, minLat, maxLon, maxLat] = graph.bbox;
  const midLat = (minLat + maxLat) / 2;
  const cellLatDeg = cellKm / KM_PER_DEG_LAT;
  const cellLonDeg = cellKm / (KM_PER_DEG_LON_EQ * Math.cos((midLat * Math.PI) / 180));
  const nx = Math.max(1, Math.ceil((maxLon - minLon) / cellLonDeg));
  const ny = Math.max(1, Math.ceil((maxLat - minLat) / cellLatDeg));
  const minutes = new Uint16Array(nx * ny).fill(GRID_NONE);
  for (let u = 0; u < graph.nodeCount; u++) {
    const end = graph.csrOffset[u + 1];
    for (let e = graph.csrOffset[u]; e < end; e++) {
      const t = field.time[graph.edgeId[e]];
      if (!Number.isFinite(t)) continue;
      const v = graph.edgeTarget[e];
      const lon = (graph.nodeLon[u] + graph.nodeLon[v]) / 2;
      const lat = (graph.nodeLat[u] + graph.nodeLat[v]) / 2;
      const cx = Math.min(nx - 1, Math.max(0, Math.floor((lon - minLon) / cellLonDeg)));
      const cy = Math.min(ny - 1, Math.max(0, Math.floor((maxLat - lat) / cellLatDeg)));
      const m = Math.min(GRID_NONE - 1, Math.round(t / 60));
      const i = cy * nx + cx;
      if (m < minutes[i]) minutes[i] = m;
    }
  }
  return { nx, ny, westLon: minLon, northLat: maxLat, cellLonDeg, cellLatDeg, minutes };
}

export interface EffortFieldResponse {
  readonly grid: EffortGrid | null;
  readonly count: number;
  readonly snappedNode: number;
  readonly snappedLat: number;
  readonly snappedLon: number;
  readonly maxTime: number;
  readonly maxCumAscent: number;
  readonly edgeIds: Uint32Array;
  readonly times: Float32Array;
  readonly cumAscents: Float32Array;
}

/**
 * Serialise a computed effort field. Emits edges in ascending edge_id order,
 * which is deterministic and lets the client binary-search if it ever wants to.
 */
export function serializeEffortField(
  graph: Graph,
  snappedNode: number,
  field: EffortField,
  grid: EffortGrid | null = null,
): ArrayBuffer {
  const count = field.count;
  const body = EFFORT_HEADER_SIZE + 12 * count;
  const trailer = grid === null ? 0 : GRID_HEADER_SIZE + 2 * grid.nx * grid.ny;
  const buffer = new ArrayBuffer(body + trailer);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < 4; i++) bytes[i] = EFFORT_MAGIC.charCodeAt(i);
  view.setUint16(4, EFFORT_FORMAT_VERSION, true);
  view.setUint16(6, EFFORT_HEADER_SIZE, true);
  view.setUint32(8, count, true);
  view.setUint32(12, snappedNode, true);
  view.setFloat32(16, graph.nodeLat[snappedNode], true);
  view.setFloat32(20, graph.nodeLon[snappedNode], true);

  const ids = new Uint32Array(buffer, EFFORT_HEADER_SIZE, count);
  const times = new Float32Array(buffer, EFFORT_HEADER_SIZE + 4 * count, count);
  const cum = new Float32Array(buffer, EFFORT_HEADER_SIZE + 8 * count, count);

  let maxTime = 0;
  let maxCum = 0;
  let w = 0;
  for (let id = 0; id < field.time.length; id++) {
    const t = field.time[id];
    if (!Number.isFinite(t)) continue;
    ids[w] = id;
    times[w] = t;
    cum[w] = field.cumAscent[id];
    if (t > maxTime) maxTime = t;
    if (field.cumAscent[id] > maxCum) maxCum = field.cumAscent[id];
    w++;
  }
  // `count` came from field.count; the write cursor must land on exactly it.
  if (w !== count) throw new Error(`effort field count mismatch: wrote ${w}, expected ${count}`);

  view.setFloat32(24, maxTime, true);
  view.setFloat32(28, maxCum, true);

  if (grid !== null) {
    for (let i = 0; i < 4; i++) bytes[body + i] = GRID_MAGIC.charCodeAt(i);
    view.setUint32(body + 4, grid.nx, true);
    view.setUint32(body + 8, grid.ny, true);
    view.setFloat32(body + 12, grid.westLon, true);
    view.setFloat32(body + 16, grid.northLat, true);
    view.setFloat32(body + 20, grid.cellLonDeg, true);
    view.setFloat32(body + 24, grid.cellLatDeg, true);
    new Uint16Array(buffer, body + GRID_HEADER_SIZE, grid.nx * grid.ny).set(grid.minutes);
  }
  return buffer;
}

/** Parse a serialized effort field. Views are zero-copy over `buffer`. */
export function parseEffortFieldResponse(buffer: ArrayBuffer): EffortFieldResponse {
  if (buffer.byteLength < EFFORT_HEADER_SIZE) {
    throw new ApiError('effort-field response shorter than its header', 500);
  }
  const view = new DataView(buffer);
  let magic = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== EFFORT_MAGIC) throw new ApiError(`bad effort-field magic ${JSON.stringify(magic)}`, 500);
  if (view.getUint16(4, true) !== EFFORT_FORMAT_VERSION) throw new ApiError('unsupported version', 500);

  const count = view.getUint32(8, true);
  const body = EFFORT_HEADER_SIZE + 12 * count;
  let grid: EffortGrid | null = null;
  if (buffer.byteLength > body) {
    let gm = '';
    for (let i = 0; i < 4; i++) gm += String.fromCharCode(bytes[body + i]);
    if (gm !== GRID_MAGIC) throw new ApiError('effort-field has trailing bytes without a grid', 500);
    const nx = view.getUint32(body + 4, true);
    const ny = view.getUint32(body + 8, true);
    if (buffer.byteLength !== body + GRID_HEADER_SIZE + 2 * nx * ny) {
      throw new ApiError('effort-field grid truncated', 500);
    }
    grid = {
      nx,
      ny,
      westLon: view.getFloat32(body + 12, true),
      northLat: view.getFloat32(body + 16, true),
      cellLonDeg: view.getFloat32(body + 20, true),
      cellLatDeg: view.getFloat32(body + 24, true),
      minutes: new Uint16Array(buffer, body + GRID_HEADER_SIZE, nx * ny),
    };
  } else if (buffer.byteLength !== body) {
    throw new ApiError(`effort-field truncated: ${buffer.byteLength} bytes, expected ${body}`, 500);
  }
  return {
    grid,
    count,
    snappedNode: view.getUint32(12, true),
    snappedLat: view.getFloat32(16, true),
    snappedLon: view.getFloat32(20, true),
    maxTime: view.getFloat32(24, true),
    maxCumAscent: view.getFloat32(28, true),
    edgeIds: new Uint32Array(buffer, EFFORT_HEADER_SIZE, count),
    times: new Float32Array(buffer, EFFORT_HEADER_SIZE + 4 * count, count),
    cumAscents: new Float32Array(buffer, EFFORT_HEADER_SIZE + 8 * count, count),
  };
}
