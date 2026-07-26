/**
 * API client request-building, with fetch mocked. The key assertions: profile
 * speeds and filters go on the wire; the Fitness factor never does.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Surface, effortField, route, snap } from '../src/lib/api.ts';
import { fromKmh } from '../src/lib/profile.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(HERE, 'fixtures', 'effort-sample.bin'));
const SAMPLE_AB = SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength);

const MIXED = fromKmh(27, 700);

interface Captured {
  url: string;
  body: Record<string, unknown> | null;
}

function mockFetch(response: () => Response): Captured {
  const captured: Captured = { url: '', body: null };
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    return Promise.resolve(response());
  });
  return captured;
}

afterEach(() => vi.unstubAllGlobals());

describe('effortField request', () => {
  it('sends profile speeds and the budget, never a fitness factor', async () => {
    const cap = mockFetch(() => new Response(SAMPLE_AB, { status: 200 }));
    const field = await effortField({ lat: 46.5, lon: 8.03 }, MIXED, {}, 28800);

    expect(cap.url).toContain('/effort-field');
    expect(cap.body).toMatchObject({
      lat: 46.5, lon: 8.03, v_flat: MIXED.vFlatMps, vam: MIXED.vamMps, max_cost: 28800,
    });
    expect(cap.body).not.toHaveProperty('fitness');
    expect(cap.body).not.toHaveProperty('alpha');
    // The response was parsed as VEFF.
    expect(field.count).toBeGreaterThan(0);
  });

  it('includes slope and surface filters only when set', async () => {
    const cap = mockFetch(() => new Response(SAMPLE_AB, { status: 200 }));
    await effortField({ lat: 46.5, lon: 8.03 }, MIXED, {
      maxSlopePct: 8,
      surfaces: [Surface.Paved, Surface.Gravel],
    });
    expect(cap.body).toMatchObject({ max_slope: 8, surfaces: [1, 2] });
  });

  it('omits filters when none are given', async () => {
    const cap = mockFetch(() => new Response(SAMPLE_AB, { status: 200 }));
    await effortField({ lat: 46.5, lon: 8.03 }, MIXED);
    expect(cap.body).not.toHaveProperty('max_slope');
    expect(cap.body).not.toHaveProperty('surfaces');
  });

  it('throws on a non-ok response', async () => {
    mockFetch(() => new Response('nope', { status: 400 }));
    await expect(effortField({ lat: 46.5, lon: 8.03 }, MIXED)).rejects.toThrow(/effort-field failed/);
  });
});

describe('route request', () => {
  it('sends from/to as [lat, lon] pairs and the profile speeds', async () => {
    const cap = mockFetch(
      () => new Response(JSON.stringify({ found: false, from_snapped: {}, to_snapped: {} }), { status: 200 }),
    );
    await route({ lat: 46.5, lon: 8.0 }, { lat: 46.52, lon: 8.06 }, MIXED, { surfaces: [Surface.Paved] });
    expect(cap.body).toMatchObject({
      from: [46.5, 8.0], to: [46.52, 8.06], v_flat: MIXED.vFlatMps, vam: MIXED.vamMps, surfaces: [1],
    });
  });

  it('returns the parsed JSON result', async () => {
    mockFetch(
      () => new Response(JSON.stringify({ found: true, cost_s: 1200, dist_m: 5000, from_snapped: {}, to_snapped: {} }), { status: 200 }),
    );
    const r = await route({ lat: 46.5, lon: 8 }, { lat: 46.5, lon: 8.1 }, MIXED);
    expect(r.found).toBe(true);
    expect(r.cost_s).toBe(1200);
  });
});

describe('snap request', () => {
  it('puts lat/lon in the query string', async () => {
    const cap = mockFetch(() => new Response(JSON.stringify({ node: 5, lat: 46.5, lon: 8.0 }), { status: 200 }));
    const s = await snap({ lat: 46.5, lon: 8.03 });
    expect(cap.url).toContain('lat=46.5');
    expect(cap.url).toContain('lon=8.03');
    expect(s.node).toBe(5);
  });
});
