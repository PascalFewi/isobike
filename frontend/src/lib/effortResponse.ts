/**
 * Parser for the Worker's `/effort-field` binary response (VEFF v2).
 *
 * Mirrors `worker/src/protocol.ts` -- the same 32-byte header then three parallel
 * arrays (edge_id u32, time f32, cum_ascent f32), followed by zero or more grid
 * trailers ("VGRD") with the minimum minutes per map cell, one per requested
 * cell size, which the client turns into isolines. The app asks for the grids
 * alone (`edges: false`), so its responses carry no edges. The layout is a
 * cross-boundary contract; `frontend/test/effortResponse.test.ts` checks this
 * parser against fixtures emitted by the worker's own serializer, so drift is
 * caught.
 *
 * Views are zero-copy over the received ArrayBuffer; the typed arrays are read
 * straight from the response bytes.
 */

const MAGIC = 'VEFF';
const FORMAT_VERSION = 2;
const HEADER_SIZE = 32;
const GRID_MAGIC = 'VGRD';
const GRID_HEADER_SIZE = 32;
/** Grid cell value for "no reachable road here". */
export const GRID_NONE = 65535;

export interface EffortGrid {
  readonly nx: number;
  readonly ny: number;
  /** West edge of column 0 / north edge of row 0, degrees. */
  readonly westLon: number;
  readonly northLat: number;
  readonly cellLonDeg: number;
  readonly cellLatDeg: number;
  /** Minutes, row-major north -> south; {@link GRID_NONE} where nothing is reached. */
  readonly minutes: Uint16Array;
}

export interface EffortField {
  readonly count: number;
  readonly snappedNode: number;
  readonly snappedLat: number;
  readonly snappedLon: number;
  /** Max reach time in the field, seconds -- for colour-band scaling (channel 1). */
  readonly maxTime: number;
  /** Max cumulative ascent, metres -- for the second channel's scaling. */
  readonly maxCumAscent: number;
  readonly edgeIds: Uint32Array;
  readonly times: Float32Array;
  readonly cumAscents: Float32Array;
  /** One per `grid_km` size of the request, in its order. */
  readonly grids: readonly EffortGrid[];
}

function ascii(bytes: Uint8Array, at: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

export function parseEffortField(buffer: ArrayBuffer): EffortField {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`effort-field response shorter than its ${HEADER_SIZE}-byte header`);
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const magic = ascii(bytes, 0);
  if (magic !== MAGIC) throw new Error(`bad effort-field magic ${JSON.stringify(magic)}`);
  if (view.getUint16(4, true) !== FORMAT_VERSION) {
    throw new Error('unsupported effort-field version');
  }

  const count = view.getUint32(8, true);
  const body = HEADER_SIZE + 12 * count;
  if (buffer.byteLength < body) {
    throw new Error(`effort-field truncated: ${buffer.byteLength} bytes, expected ${body}`);
  }
  const grids: EffortGrid[] = [];
  for (let at = body; at < buffer.byteLength; ) {
    if (ascii(bytes, at) !== GRID_MAGIC) throw new Error('effort-field has trailing bytes without a grid');
    const nx = view.getUint32(at + 4, true);
    const ny = view.getUint32(at + 8, true);
    const end = at + GRID_HEADER_SIZE + 2 * nx * ny;
    if (buffer.byteLength < end) throw new Error('effort-field grid truncated');
    grids.push({
      nx,
      ny,
      westLon: view.getFloat32(at + 12, true),
      northLat: view.getFloat32(at + 16, true),
      cellLonDeg: view.getFloat32(at + 20, true),
      cellLatDeg: view.getFloat32(at + 24, true),
      minutes: new Uint16Array(buffer, at + GRID_HEADER_SIZE, nx * ny),
    });
    at = end;
  }

  return {
    count,
    snappedNode: view.getUint32(12, true),
    snappedLat: view.getFloat32(16, true),
    snappedLon: view.getFloat32(20, true),
    maxTime: view.getFloat32(24, true),
    maxCumAscent: view.getFloat32(28, true),
    edgeIds: new Uint32Array(buffer, HEADER_SIZE, count),
    times: new Float32Array(buffer, HEADER_SIZE + 4 * count, count),
    cumAscents: new Float32Array(buffer, HEADER_SIZE + 8 * count, count),
    grids,
  };
}
