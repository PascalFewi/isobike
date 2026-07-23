/**
 * HTTP endpoint logic, one function per route, plus the dispatcher.
 *
 * Each handler takes an already-loaded {@link Graph} and a `Request` and returns
 * a `Response`. That split is deliberate: it keeps the handlers free of R2 and of
 * the Worker's global cache, so vitest drives them with the Ridge-World graph and
 * a hand-built `Request` -- no network, no mocking of Cloudflare.
 *
 * Handlers throw {@link ApiError} on bad input; {@link handleRequest} is the one
 * place that formats errors into responses, so a new endpoint cannot forget to.
 */

import { snap } from './router.js';
import { effortField, route } from './router.js';
import type { Graph } from './binformat.js';
import {
  ApiError,
  parseEffortFieldBody,
  parseRouteBody,
  parseSnapQuery,
  serializeEffortField,
} from './protocol.js';

/** Same on every response. `*` is fine for a public, read-only routing API. */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonResponse({ error: err.message }, err.status);
  }
  // Never leak internals; a bug is a 500 with a generic message.
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: 'internal error', detail: message }, 500);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError('request body must be valid JSON');
  }
}

function snapped(graph: Graph, node: number): { node: number; lat: number; lon: number } {
  return { node, lat: graph.nodeLat[node], lon: graph.nodeLon[node] };
}

// --------------------------------------------------------------------------- //
// Endpoints
// --------------------------------------------------------------------------- //

/** `POST /effort-field` -> binary `(edge_id, time, cum_ascent)` field. */
export async function handleEffortField(graph: Graph, request: Request): Promise<Response> {
  const req = parseEffortFieldBody(await readJsonBody(request));
  const source = snap(graph, req.lat, req.lon);
  const field = effortField(graph, source, req.model, {
    maxSlopePct: req.maxSlopePct,
    maxCost: req.maxCost,
  });
  const buffer = serializeEffortField(graph, source, field);
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'x-effort-count': String(field.count),
      'x-snapped-node': String(source),
      // Dynamic per start point; never a shared cache entry.
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

/** `POST /route` -> JSON route with summed stats, or `{found:false}`. */
export async function handleRoute(graph: Graph, request: Request): Promise<Response> {
  const req = parseRouteBody(await readJsonBody(request));
  const from = snap(graph, req.from[0], req.from[1]);
  const to = snap(graph, req.to[0], req.to[1]);
  const result = route(graph, from, to, req.model, { maxSlopePct: req.maxSlopePct });

  const base = { from_snapped: snapped(graph, from), to_snapped: snapped(graph, to) };
  if (result === null) {
    // A real answer, not an error: the two ends do not connect under this filter.
    return jsonResponse({ ...base, found: false });
  }
  return jsonResponse({
    ...base,
    found: true,
    cost_s: result.cost,
    dist_m: result.distM,
    ascent_m: result.ascentM,
    descent_m: result.descentM,
    max_slope_pct: result.maxSlopePct,
    edge_ids: result.edgeIds,
    nodes: result.nodes,
  });
}

/** `GET /snap?lat=&lon=` -> the nearest graph node and its coordinates. */
export function handleSnap(graph: Graph, request: Request): Response {
  const q = parseSnapQuery(new URL(request.url));
  return jsonResponse(snapped(graph, snap(graph, q.lat, q.lon)));
}

// --------------------------------------------------------------------------- //
// Dispatch
// --------------------------------------------------------------------------- //

/**
 * Route a request to its handler and format any error. Pure over `graph`, so the
 * whole API surface is testable without R2 or a live Worker.
 */
export async function handleRequest(graph: Graph, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (pathname === '/effort-field') {
      if (request.method !== 'POST') throw new ApiError('use POST', 405);
      return await handleEffortField(graph, request);
    }
    if (pathname === '/route') {
      if (request.method !== 'POST') throw new ApiError('use POST', 405);
      return await handleRoute(graph, request);
    }
    if (pathname === '/snap') {
      if (request.method !== 'GET') throw new ApiError('use GET', 405);
      return handleSnap(graph, request);
    }
    if (pathname === '/health') {
      return jsonResponse({
        ok: true,
        region: graph.regionId,
        nodes: graph.nodeCount,
        edges: graph.geomEdgeCount,
      });
    }
    return jsonResponse({ error: `no route for ${pathname}` }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
