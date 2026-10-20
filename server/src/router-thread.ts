/**
 * One routing thread: loads graph.bin once, reads geometry.bin by range, and
 * answers requests forwarded by main.ts with the Worker's own `handleRequest`.
 *
 * Dijkstra is synchronous CPU work (~0.3 s for a nationwide field), so it runs
 * here and never on the thread that accepts connections.
 */

import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { readGraph } from '../../worker/src/binformat.js';
import { createGeometrySource, type GeometrySource } from '../../worker/src/geometry.js';
import { handleRequest } from '../../worker/src/handlers.js';

export interface ThreadRequest {
  readonly id: number;
  readonly method: string;
  readonly url: string;
  readonly headers: Array<[string, string]>;
  readonly body: string | null;
}

export interface ThreadResponse {
  readonly id: number;
  readonly status: number;
  readonly headers: Array<[string, string]>;
  readonly body: ArrayBuffer;
}

const { dataDir } = workerData as { dataDir: string };
const port = parentPort!;

const bytes = await readFile(join(dataDir, 'graph.bin'));
const graph = readGraph(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
  verifyChecksum: true,
});

let geometry: GeometrySource | undefined;
const geomPath = join(dataDir, 'geometry.bin');
if (await stat(geomPath).then(() => true, () => false)) {
  const fh = await open(geomPath, 'r');
  geometry = createGeometrySource({
    async read(offset, length) {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      if (bytesRead !== length) throw new Error(`geometry.bin short read at ${offset}`);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) as ArrayBuffer;
    },
  });
}

port.on('message', async (msg: ThreadRequest) => {
  const request = new Request(`http://isobike.local${msg.url}`, {
    method: msg.method,
    headers: msg.headers,
    ...(msg.body !== null ? { body: msg.body } : {}),
  });
  const response = await handleRequest(graph, request, geometry !== undefined ? { geometry } : {});
  const body = await response.arrayBuffer();
  const reply: ThreadResponse = { id: msg.id, status: response.status, headers: [...response.headers], body };
  port.postMessage(reply, [body]);
});

port.postMessage({ ready: true, region: graph.regionId, nodes: graph.nodeCount, geometry: geometry !== undefined });
