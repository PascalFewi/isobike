/**
 * Loads and caches the parsed graph for the lifetime of a Worker isolate.
 *
 * The graph is ~60 MB nationwide and parsing + CRC is the cold-start cost. A
 * Worker isolate serves many requests, so the parse must happen once and be
 * reused -- that is the whole point of holding it at module scope in index.ts.
 *
 * The store is deliberately built around an injected `loadBytes` thunk rather
 * than an R2 binding, so vitest exercises the caching and error paths with the
 * Ridge-World bytes and no Cloudflare mock.
 */

import { readGraph, type Graph } from './binformat.js';

export interface GraphStore {
  /** Resolve the parsed graph, loading and caching it on first call. */
  get(): Promise<Graph>;
}

/**
 * Cache the *promise*, not the graph, so concurrent cold requests share a single
 * load instead of each fetching 60 MB from R2. On failure the cache is cleared so
 * the next request retries rather than being stuck with a poisoned rejection.
 */
export function createGraphStore(loadBytes: () => Promise<ArrayBuffer>): GraphStore {
  let cached: Promise<Graph> | null = null;

  return {
    get(): Promise<Graph> {
      if (cached === null) {
        const pending = (async () => {
          const bytes = await loadBytes();
          // Verify the CRC once per isolate on the cold path; ~80 ms on 60 MB is
          // cheap insurance against a truncated or corrupted R2 object. Edge
          // lengths are a build-time property, not re-checked here.
          return readGraph(bytes, { verifyChecksum: true });
        })();
        pending.catch(() => {
          if (cached === pending) cached = null;
        });
        cached = pending;
      }
      return cached;
    },
  };
}
