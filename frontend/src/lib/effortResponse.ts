/**
 * Parser for the Worker's `/effort-field` binary response (VEFF).
 *
 * Mirrors `worker/src/protocol.ts` -- the same 32-byte header then three parallel
 * arrays (edge_id u32, time f32, cum_ascent f32). The layout is a cross-boundary
 * contract; `frontend/test/effortResponse.test.ts` checks this parser against a
 * fixture emitted by the worker's own serializer, so drift is caught.
 *
 * Views are zero-copy over the received ArrayBuffer -- a nationwide field is
 * ~16 MB, so copying it would be wasteful; the typed arrays are read straight
 * from the response bytes.
 */

const MAGIC = 'VEFF';
const FORMAT_VERSION = 1;
const HEADER_SIZE = 32;

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
}

export function parseEffortField(buffer: ArrayBuffer): EffortField {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`effort-field response shorter than its ${HEADER_SIZE}-byte header`);
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== MAGIC) throw new Error(`bad effort-field magic ${JSON.stringify(magic)}`);
  if (view.getUint16(4, true) !== FORMAT_VERSION) {
    throw new Error('unsupported effort-field version');
  }

  const count = view.getUint32(8, true);
  const expected = HEADER_SIZE + 12 * count;
  if (buffer.byteLength !== expected) {
    throw new Error(`effort-field truncated: ${buffer.byteLength} bytes, expected ${expected}`);
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
  };
}
