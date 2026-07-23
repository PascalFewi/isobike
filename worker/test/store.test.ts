/**
 * Graph store caching + the Worker entrypoint's R2 wiring, exercised with the
 * Ridge-World bytes and a stub bucket. No Cloudflare, no network.
 */

import { describe, expect, it, vi } from 'vitest';

import { ChecksumError } from '../src/binformat.js';
import { createGraphStore } from '../src/graphStore.js';
import worker, { type Env, type R2Bucket } from '../src/index.js';
import { loadGraphBytes } from './fixtures.js';

const bytes = loadGraphBytes();

/** A bucket that serves the given object bytes (or 404s when bytes is null). */
function stubBucket(objectBytes: ArrayBuffer | null): { bucket: R2Bucket; getCalls: () => number } {
  let calls = 0;
  const bucket: R2Bucket = {
    async get(_key: string) {
      calls++;
      return objectBytes === null ? null : { arrayBuffer: async () => objectBytes };
    },
  };
  return { bucket, getCalls: () => calls };
}

describe('createGraphStore', () => {
  it('parses once and reuses across calls', async () => {
    const loadBytes = vi.fn(async () => bytes);
    const store = createGraphStore(loadBytes);

    const a = await store.get();
    const b = await store.get();
    expect(a).toBe(b); // same parsed graph object
    expect(a.regionId).toBe('ridge-world');
    expect(loadBytes).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold loads into one fetch', async () => {
    const loadBytes = vi.fn(async () => bytes);
    const store = createGraphStore(loadBytes);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect(a).toBe(b);
    expect(loadBytes).toHaveBeenCalledTimes(1);
  });

  it('clears the cache after a failure so the next call retries', async () => {
    let attempt = 0;
    const loadBytes = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('R2 hiccup');
      return bytes;
    });
    const store = createGraphStore(loadBytes);

    await expect(store.get()).rejects.toThrow('R2 hiccup');
    const graph = await store.get(); // retried
    expect(graph.regionId).toBe('ridge-world');
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it('rejects a corrupt object via the CRC check', async () => {
    const corrupt = bytes.slice(0);
    new Uint8Array(corrupt)[200] ^= 0xff;
    const store = createGraphStore(async () => corrupt);
    await expect(store.get()).rejects.toBeInstanceOf(ChecksumError);
  });
});

describe('worker.fetch', () => {
  function req(path: string): Request {
    return new Request(`https://worker.test${path}`);
  }

  it('serves a request once the graph loads from R2', async () => {
    const { bucket } = stubBucket(bytes);
    const env: Env = { GRAPH_BUCKET: bucket };
    const res = await worker.fetch(req('/health'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { region: string };
    expect(body.region).toBe('ridge-world');
  });

  it('reuses the parsed graph across requests to the same binding', async () => {
    const { bucket, getCalls } = stubBucket(bytes);
    const env: Env = { GRAPH_BUCKET: bucket };
    await worker.fetch(req('/health'), env);
    await worker.fetch(req('/snap?lat=46.5&lon=8.03'), env);
    expect(getCalls()).toBe(1); // R2 hit once, then cache
  });

  it('503s when the graph object is missing', async () => {
    const { bucket } = stubBucket(null);
    const env: Env = { GRAPH_BUCKET: bucket };
    const res = await worker.fetch(req('/health'), env);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('graph unavailable');
  });

  it('honours a custom GRAPH_KEY', async () => {
    let seenKey = '';
    const bucket: R2Bucket = {
      async get(key: string) {
        seenKey = key;
        return { arrayBuffer: async () => bytes };
      },
    };
    await worker.fetch(req('/health'), { GRAPH_BUCKET: bucket, GRAPH_KEY: 'ch/graph.bin' });
    expect(seenKey).toBe('ch/graph.bin');
  });
});
