/**
 * Routing API for the self-hosted deployment (Hetzner). Caddy in front serves
 * the frontend and the map tiles, compresses, and terminates TLS; this process
 * only answers the API, on 127.0.0.1.
 *
 * Requests go to a pool of routing threads (one per core, each holding its own
 * copy of the ~110 MB graph): a request waits for the least busy thread. When
 * every thread already has {@link MAX_QUEUE_PER_THREAD} waiting, new requests
 * get 503 + Retry-After instead of piling up without bound.
 *
 * Configuration (environment):
 *   DATA_DIR  directory with graph.bin and geometry.bin   (/opt/isobike/data)
 *   HOST      listen address                              (127.0.0.1)
 *   PORT      listen port                                 (8080)
 *   THREADS   routing threads                             (number of cores)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type { ThreadRequest, ThreadResponse } from './router-thread.js';

const DATA_DIR = process.env.DATA_DIR ?? '/opt/isobike/data';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8080);
const THREADS = Math.max(1, Number(process.env.THREADS ?? availableParallelism()));
const MAX_QUEUE_PER_THREAD = 8;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (r: ThreadResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  pending: Map<number, Pending>;
}

let nextId = 1;
const slots: Slot[] = [];

function spawn(index: number): void {
  const worker = new Worker(new URL('./router.js', import.meta.url), { workerData: { dataDir: DATA_DIR } });
  const slot: Slot = { worker, ready: false, pending: new Map() };
  slots[index] = slot;
  worker.on('message', (msg: ThreadResponse | { ready: true; region: string; nodes: number; geometry: boolean }) => {
    if ('ready' in msg) {
      slot.ready = true;
      console.log(`router thread ${index} ready: ${msg.region}, ${msg.nodes} nodes, geometry ${msg.geometry ? 'on' : 'off'}`);
      return;
    }
    const p = slot.pending.get(msg.id);
    if (p === undefined) return;
    clearTimeout(p.timer);
    slot.pending.delete(msg.id);
    p.resolve(msg);
  });
  worker.on('error', (err) => console.error(`router thread ${index} error:`, err));
  worker.on('exit', (code) => {
    for (const p of slot.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('router thread exited'));
    }
    console.error(`router thread ${index} exited (${code}); restarting`);
    setTimeout(() => spawn(index), 1000);
  });
}

function dispatch(req: Omit<ThreadRequest, 'id'>): Promise<ThreadResponse> {
  const ready = slots.filter((s) => s.ready);
  if (ready.length === 0) return Promise.reject(new HttpError(503, 'starting up'));
  const slot = ready.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  if (slot.pending.size >= MAX_QUEUE_PER_THREAD) return Promise.reject(new HttpError(503, 'busy'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      slot.pending.delete(id);
      reject(new HttpError(504, 'routing timed out'));
    }, REQUEST_TIMEOUT_MS);
    slot.pending.set(id, { resolve, reject, timer });
    slot.worker.postMessage({ id, ...req } satisfies ThreadRequest);
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      const ready = slots.filter((s) => s.ready).length;
      sendJson(res, ready > 0 ? 200 : 503, { ok: ready > 0, threads: THREADS, ready });
      return;
    }
    const body = await readBody(req);
    const headers = Object.entries(req.headers).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]],
    );
    const out = await dispatch({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(out.body));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) }, status === 503 ? { 'retry-after': '5' } : {});
  }
});

for (let i = 0; i < THREADS; i++) spawn(i);
server.listen(PORT, HOST, () => console.log(`isobike API on http://${HOST}:${PORT} (${THREADS} threads, data ${DATA_DIR})`));
