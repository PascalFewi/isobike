/**
 * Cloudflare Worker entrypoint.
 *
 * Thin by design: everything testable lives in `handlers.ts`, `protocol.ts`,
 * `router.ts` and is verified without a live Worker. This file only binds R2,
 * holds the isolate-scoped graph cache, and hands a loaded graph to the pure
 * dispatcher.
 *
 * The R2 surface is typed with a minimal local interface rather than pulling in
 * `@cloudflare/workers-types`, so the format/router core stays dependency-free
 * and `any`-free. It declares exactly the two methods this file calls.
 */

import { createGeometrySource, type GeometrySource } from './geometry.js';
import { createGraphStore, type GraphStore } from './graphStore.js';
import { handleRequest } from './handlers.js';

/** The slice of the R2 object API this Worker uses. */
export interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2Bucket {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null>;
}

export interface Env {
  /** R2 binding holding `graph.bin`. Configured in wrangler.toml. */
  GRAPH_BUCKET: R2Bucket;
  /** Object key; defaults to `graph.bin`. */
  GRAPH_KEY?: string;
  /** Route geometry object key; defaults to `geometry.bin`. Optional: without it
   * `/route` answers without the `geometry` polyline. */
  GEOMETRY_KEY?: string;
}

/**
 * One store per bucket binding. Keyed by the bucket object so a warm isolate
 * reuses its parsed graph across requests, while a fresh binding (a new isolate,
 * or a fresh stub in a test) gets its own cache.
 */
const stores = new WeakMap<R2Bucket, GraphStore>();

function storeFor(env: Env): GraphStore {
  let store = stores.get(env.GRAPH_BUCKET);
  if (store === undefined) {
    const key = env.GRAPH_KEY ?? 'graph.bin';
    store = createGraphStore(async () => {
      const object = await env.GRAPH_BUCKET.get(key);
      if (object === null) throw new Error(`graph object '${key}' not found in R2`);
      return object.arrayBuffer();
    });
    stores.set(env.GRAPH_BUCKET, store);
  }
  return store;
}

const geometries = new WeakMap<R2Bucket, GeometrySource>();

/** Range reads of `geometry.bin`, never the whole object (it is ~200 MB). */
function geometryFor(env: Env): GeometrySource {
  let source = geometries.get(env.GRAPH_BUCKET);
  if (source === undefined) {
    const key = env.GEOMETRY_KEY ?? 'geometry.bin';
    source = createGeometrySource({
      async read(offset, length) {
        const object = await env.GRAPH_BUCKET.get(key, { range: { offset, length } });
        if (object === null) throw new Error(`geometry object '${key}' not found in R2`);
        return object.arrayBuffer();
      },
    });
    geometries.set(env.GRAPH_BUCKET, source);
  }
  return source;
}

function graphUnavailable(err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ error: 'graph unavailable', detail }), {
    status: 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '5',
      'access-control-allow-origin': '*',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let graph;
    try {
      graph = await storeFor(env).get();
    } catch (err) {
      // Loading/parsing failed (missing object, corrupt CRC, ...). This is the
      // only place the graph can be absent; every handler assumes it present.
      return graphUnavailable(err);
    }
    return handleRequest(graph, request, { geometry: geometryFor(env) });
  },
};
