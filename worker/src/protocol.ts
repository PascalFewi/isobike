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

import type { Graph } from './binformat.js';
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

// --------------------------------------------------------------------------- //
// Parsed request shapes
// --------------------------------------------------------------------------- //

export interface EffortFieldRequest {
  readonly lat: number;
  readonly lon: number;
  readonly model: CostModel;
  readonly maxSlopePct: number | undefined;
  readonly maxCost: number;
}

export function parseEffortFieldBody(raw: unknown): EffortFieldRequest {
  const body = asObject(raw);
  const [lat, lon] = requireLatLon(body, 'start');
  const model = resolveCostModel(body);
  const maxCost = optionalFiniteNumber(body.max_cost, 'max_cost');
  if (maxCost !== undefined && maxCost <= 0) throw new ApiError('max_cost must be positive (seconds)');
  return {
    lat,
    lon,
    model,
    maxSlopePct: resolveMaxSlope(body),
    maxCost: maxCost ?? DEFAULT_BUDGET_S,
  };
}

export interface RouteRequest {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly model: CostModel;
  readonly maxSlopePct: number | undefined;
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
//     4    2  u16      format_version (== 1)
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

export const EFFORT_MAGIC = 'VEFF';
export const EFFORT_FORMAT_VERSION = 1;
export const EFFORT_HEADER_SIZE = 32;

import type { EffortField } from './router.js';

export interface EffortFieldResponse {
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
): ArrayBuffer {
  const count = field.count;
  const buffer = new ArrayBuffer(EFFORT_HEADER_SIZE + 12 * count);
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
  const expected = EFFORT_HEADER_SIZE + 12 * count;
  if (buffer.byteLength !== expected) {
    throw new ApiError(`effort-field truncated: ${buffer.byteLength} bytes, expected ${expected}`, 500);
  }
  return {
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
