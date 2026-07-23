import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGraph, type Graph } from '../src/binformat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TESTDATA_DIR = join(HERE, '..', '..', 'testdata', 'ridge_world');

/**
 * Read a file as a standalone ArrayBuffer.
 *
 * `readFileSync` returns a Buffer that is often a *view into a shared pool*, so
 * `buffer.buffer` may start thousands of bytes before the file's first byte and
 * be far longer than the file. Handing that straight to `readGraph` would make
 * every section offset wrong. Copying out the exact range is the fix.
 */
export function readAsArrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function loadGraphBytes(): ArrayBuffer {
  return readAsArrayBuffer(join(TESTDATA_DIR, 'graph.bin'));
}

export function loadRidgeWorld(): Graph {
  return readGraph(loadGraphBytes(), { checkEdgeLengths: true });
}

// --------------------------------------------------------------------------- //
// expected.json
// --------------------------------------------------------------------------- //

export interface ExpectedRoute {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly climb_factor: number;
  readonly max_slope_pct: number | null;
  readonly found: boolean;
  readonly cost?: number;
  readonly dist_m?: number;
  readonly ascent_m?: number;
  readonly descent_m?: number;
  readonly result_max_slope_pct?: number;
  readonly nodes?: number[];
  readonly edge_ids?: number[];
}

export interface ExpectedField {
  readonly source: number;
  readonly climb_factor: number;
  readonly max_slope_pct: number | null;
  readonly max_cost: number | null;
  readonly edge_count: number;
  readonly entries: ReadonlyArray<readonly [number, number]>;
}

export interface Expected {
  readonly schema: number;
  readonly region_id: string;
  readonly constants: {
    readonly r_earth_m: number;
    readonly h_safety: number;
    readonly slope_step_pct: number;
    readonly bump_height_m: number;
  };
  readonly graph: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly format_version: number;
    readonly node_count: number;
    readonly dir_edge_count: number;
    readonly geom_edge_count: number;
    readonly grid_nx: number;
    readonly grid_ny: number;
    readonly bbox: [number, number, number, number];
  };
  readonly fixtures: {
    readonly bump_anchor: number;
    readonly bump_a: number;
    readonly bump_b: number;
    readonly island: [number, number, number];
  };
  readonly snap: ReadonlyArray<{ readonly lat: number; readonly lon: number; readonly node: number }>;
  readonly routes: readonly ExpectedRoute[];
  readonly effort_fields: readonly ExpectedField[];
}

export function loadExpected(): Expected {
  return JSON.parse(readFileSync(join(TESTDATA_DIR, 'expected.json'), 'utf8')) as Expected;
}

/** `null` in the golden files means "no limit"; the router API uses undefined/Infinity. */
export function toSlopeLimit(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

export function toBudget(value: number | null): number {
  return value === null ? Infinity : value;
}
