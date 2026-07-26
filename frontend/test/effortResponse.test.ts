/**
 * The VEFF parser against a fixture emitted by the WORKER's own serializer
 * (worker/test/frontend-fixture.test.ts). This is the cross-boundary check that
 * the frontend reads exactly what the worker writes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseEffortField } from '../src/lib/effortResponse.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');

function loadSampleBuffer(): ArrayBuffer {
  const buf = readFileSync(join(FIXTURE_DIR, 'effort-sample.bin'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface Sample {
  count: number;
  snappedNode: number;
  snappedLat: number;
  snappedLon: number;
  maxTime: number;
  maxCumAscent: number;
  entries: Array<{ edgeId: number; time: number; cumAscent: number }>;
}

function loadSampleJson(): Sample {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'effort-sample.json'), 'utf8')) as Sample;
}

describe('parseEffortField against the worker fixture', () => {
  const field = parseEffortField(loadSampleBuffer());
  const expected = loadSampleJson();

  it('reads the header the worker wrote', () => {
    expect(field.count).toBe(expected.count);
    expect(field.snappedNode).toBe(expected.snappedNode);
    expect(field.snappedLat).toBe(expected.snappedLat);
    expect(field.snappedLon).toBe(expected.snappedLon);
    expect(field.maxTime).toBe(expected.maxTime);
    expect(field.maxCumAscent).toBe(expected.maxCumAscent);
  });

  it('exposes count-length parallel arrays', () => {
    expect(field.edgeIds.length).toBe(field.count);
    expect(field.times.length).toBe(field.count);
    expect(field.cumAscents.length).toBe(field.count);
  });

  it('reproduces the sampled entries by edge id', () => {
    const byId = new Map<number, number>();
    field.edgeIds.forEach((id, i) => byId.set(id, i));
    for (const e of expected.entries) {
      const i = byId.get(e.edgeId);
      expect(i, `edge ${e.edgeId}`).not.toBeUndefined();
      expect(field.times[i!]).toBe(e.time);
      expect(field.cumAscents[i!]).toBe(e.cumAscent);
    }
  });

  it('exposes zero-copy views over the buffer', () => {
    const buffer = loadSampleBuffer();
    const f = parseEffortField(buffer);
    expect(f.edgeIds.buffer).toBe(buffer);
    expect(f.edgeIds.byteOffset % 4).toBe(0);
    expect(f.times.byteOffset % 4).toBe(0);
  });
});

describe('parseEffortField rejects malformed input', () => {
  it('rejects a short buffer', () => {
    expect(() => parseEffortField(new ArrayBuffer(8))).toThrow(/header/);
  });

  it('rejects bad magic', () => {
    const buf = loadSampleBuffer().slice(0);
    new Uint8Array(buf)[0] ^= 0xff;
    expect(() => parseEffortField(buf)).toThrow(/magic/);
  });

  it('rejects a truncated payload', () => {
    expect(() => parseEffortField(loadSampleBuffer().slice(0, 64))).toThrow(/truncated/);
  });
});
