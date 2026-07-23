/**
 * End-to-end endpoint tests: real Request objects through handleRequest against
 * the Ridge-World graph, results checked against direct router calls. No network,
 * no R2 -- the handlers are pure over the graph by design.
 */

import { describe, expect, it } from 'vitest';

import { handleRequest } from '../src/handlers.js';
import { parseEffortFieldResponse } from '../src/protocol.js';
import { effortField, route, snap, timeModel } from '../src/router.js';
import { loadRidgeWorld } from './fixtures.js';

const graph = loadRidgeWorld();
const MIXED = { v_flat: 7.5, vam: 0.19444444444444445 };
const MIXED_MODEL = timeModel(MIXED.v_flat, MIXED.vam);

function post(path: string, body: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://worker.test${path}`, { method: 'GET' });
}

/** `res.json()` is `unknown` under strict mode; tests read loosely-typed bodies. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

/** Coordinates that snap exactly to a given node (its own stored position). */
function at(node: number): { lat: number; lon: number } {
  return { lat: graph.nodeLat[node], lon: graph.nodeLon[node] };
}

// --------------------------------------------------------------------------- //
// /health and CORS
// --------------------------------------------------------------------------- //

describe('/health and cross-cutting concerns', () => {
  it('reports the loaded graph', async () => {
    const res = await handleRequest(graph, get('/health'));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body).toMatchObject({ ok: true, region: 'ridge-world', nodes: graph.nodeCount });
  });

  it('sets CORS headers on every response', async () => {
    const res = await handleRequest(graph, get('/health'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers an OPTIONS preflight with 204', async () => {
    const res = await handleRequest(graph, new Request('https://worker.test/route', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('404s an unknown path and 405s a wrong method', async () => {
    expect((await handleRequest(graph, get('/nope'))).status).toBe(404);
    expect((await handleRequest(graph, get('/effort-field'))).status).toBe(405);
    expect((await handleRequest(graph, post('/snap', {}))).status).toBe(405);
  });
});

// --------------------------------------------------------------------------- //
// /snap
// --------------------------------------------------------------------------- //

describe('/snap', () => {
  it('returns the nearest node and its coordinates', async () => {
    const target = 123;
    const { lat, lon } = at(target);
    const res = await handleRequest(graph, get(`/snap?lat=${lat}&lon=${lon}`));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.node).toBe(target);
    expect(body.lat).toBe(graph.nodeLat[target]);
    expect(body.lon).toBe(graph.nodeLon[target]);
  });

  it('snaps a point outside the bbox to the border', async () => {
    const res = await handleRequest(graph, get('/snap?lat=46.4&lon=7.9'));
    const body = await jsonBody(res);
    expect(body.node).toBe(snap(graph, 46.4, 7.9));
  });

  it('400s on missing or bad params', async () => {
    expect((await handleRequest(graph, get('/snap?lat=46.5'))).status).toBe(400);
    expect((await handleRequest(graph, get('/snap?lat=x&lon=8'))).status).toBe(400);
  });
});

// --------------------------------------------------------------------------- //
// /effort-field
// --------------------------------------------------------------------------- //

describe('/effort-field', () => {
  it('returns a binary field matching a direct router call', async () => {
    const source = 100;
    const res = await handleRequest(
      graph,
      post('/effort-field', { ...at(source), ...MIXED, max_cost: 100_000 }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-snapped-node')).toBe(String(source));

    const parsed = parseEffortFieldResponse(await res.arrayBuffer());
    const direct = effortField(graph, source, MIXED_MODEL, { maxCost: 100_000 });

    expect(parsed.count).toBe(direct.count);
    expect(parsed.snappedNode).toBe(source);
    for (let i = 0; i < parsed.count; i++) {
      const id = parsed.edgeIds[i];
      expect(parsed.times[i]).toBe(Math.fround(direct.time[id]));
      expect(parsed.cumAscents[i]).toBe(Math.fround(direct.cumAscent[id]));
    }
  });

  it('honours the slope filter and budget', async () => {
    const source = 100;
    const filtered = parseEffortFieldResponse(
      await (
        await handleRequest(graph, post('/effort-field', { ...at(source), ...MIXED, max_slope: 8 }))
      ).arrayBuffer(),
    );
    const unfiltered = parseEffortFieldResponse(
      await (
        await handleRequest(graph, post('/effort-field', { ...at(source), ...MIXED, max_cost: 100_000 }))
      ).arrayBuffer(),
    );
    expect(filtered.count).toBeLessThan(unfiltered.count);
  });

  it('carries the max-time and max-cum-ascent for client colour scaling', async () => {
    const parsed = parseEffortFieldResponse(
      await (
        await handleRequest(graph, post('/effort-field', { ...at(0), ...MIXED, max_cost: 100_000 }))
      ).arrayBuffer(),
    );
    expect(parsed.maxTime).toBeGreaterThan(0);
    expect(parsed.maxCumAscent).toBeGreaterThan(0);
  });

  it('400s on a missing profile or bad JSON', async () => {
    expect((await handleRequest(graph, post('/effort-field', { ...at(0) }))).status).toBe(400);
    const badJson = new Request('https://worker.test/effort-field', {
      method: 'POST',
      body: '{not json',
    });
    expect((await handleRequest(graph, badJson)).status).toBe(400);
  });
});

// --------------------------------------------------------------------------- //
// /route
// --------------------------------------------------------------------------- //

describe('/route', () => {
  it('returns a route with stats matching a direct call', async () => {
    const from = 287;
    const to = 306;
    const res = await handleRequest(graph, post('/route', { from: at(from), to: at(to), ...MIXED }));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const direct = route(graph, from, to, MIXED_MODEL)!;

    expect(body.found).toBe(true);
    expect(body.from_snapped.node).toBe(from);
    expect(body.to_snapped.node).toBe(to);
    expect(body.cost_s).toBe(direct.cost);
    expect(body.dist_m).toBe(direct.distM);
    expect(body.ascent_m).toBe(direct.ascentM);
    expect(body.descent_m).toBe(direct.descentM);
    expect(body.max_slope_pct).toBe(direct.maxSlopePct);
    expect(body.edge_ids).toEqual(direct.edgeIds);
  });

  it('reports found:false for an unreachable pair, still echoing the snapped ends', async () => {
    const island = 354; // isolated component
    const res = await handleRequest(graph, post('/route', { from: at(0), to: at(island), ...MIXED }));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.found).toBe(false);
    expect(body.from_snapped.node).toBe(0);
    expect(body.to_snapped.node).toBe(island);
  });

  it('reports found:false when the slope filter walls off the ridge', async () => {
    const res = await handleRequest(
      graph,
      post('/route', { from: at(287), to: at(306), ...MIXED, max_slope: 6 }),
    );
    const body = await jsonBody(res);
    expect(body.found).toBe(false);
  });

  it('accepts the alpha fallback', async () => {
    const res = await handleRequest(graph, post('/route', { from: at(287), to: at(306), alpha: 0 }));
    const body = await jsonBody(res);
    // alpha=0 -> cf=0 -> pure shortest; cost equals distance under that model.
    expect(body.found).toBe(true);
    expect(body.cost_s).toBeCloseTo(body.dist_m, 6);
  });

  it('400s on a missing endpoint', async () => {
    expect((await handleRequest(graph, post('/route', { from: at(0), ...MIXED }))).status).toBe(400);
  });
});
