/**
 * The heap is the one piece of the router with no Python counterpart to check it
 * against, so it is checked against a sorted array instead.
 */

import { describe, expect, it } from 'vitest';

import { BinaryHeap } from '../src/heap.js';

/** Deterministic PRNG -- a flaky property test is worse than no property test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drain(heap: BinaryHeap): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  while (heap.pop()) out.push([heap.topKey, heap.topId]);
  return out;
}

/** The ordering the reference router's `heapq` tuples impose. */
function lexicographic(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

describe('BinaryHeap', () => {
  it('reports empty correctly', () => {
    const heap = new BinaryHeap();
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBe(false);
  });

  it('pops a single entry', () => {
    const heap = new BinaryHeap();
    heap.push(4.5, 7);
    expect(heap.size).toBe(1);
    expect(heap.pop()).toBe(true);
    expect(heap.topKey).toBe(4.5);
    expect(heap.topId).toBe(7);
    expect(heap.pop()).toBe(false);
  });

  it.each([1, 2, 3, 7, 8, 9, 63, 64, 65, 1000])(
    'drains %i entries in sorted order',
    (n) => {
      const rand = mulberry32(n * 7919);
      const heap = new BinaryHeap(4);
      const reference: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const key = Math.floor(rand() * 1000);
        heap.push(key, i);
        reference.push([key, i]);
      }
      reference.sort(lexicographic);
      expect(drain(heap)).toEqual(reference);
    },
  );

  it('breaks key ties on node id, exactly as heapq compares (cost, node) tuples', () => {
    const heap = new BinaryHeap(2);
    // Pushed in an order that would come out wrong if ties fell back to
    // insertion order or were left unspecified.
    for (const id of [9, 3, 7, 1, 5, 0, 8]) heap.push(42, id);
    expect(drain(heap).map(([, id]) => id)).toEqual([0, 1, 3, 5, 7, 8, 9]);
  });

  it('orders by key first and id only within a key', () => {
    const heap = new BinaryHeap(2);
    heap.push(2, 0);
    heap.push(1, 9);
    heap.push(2, 1);
    heap.push(1, 4);
    expect(drain(heap)).toEqual([
      [1, 4],
      [1, 9],
      [2, 0],
      [2, 1],
    ]);
  });

  it('grows past its initial capacity without losing or reordering entries', () => {
    const heap = new BinaryHeap(1);
    const rand = mulberry32(12345);
    const reference: Array<[number, number]> = [];
    for (let i = 0; i < 5000; i++) {
      const key = rand() * 1e6;
      heap.push(key, i);
      reference.push([key, i]);
    }
    expect(heap.size).toBe(5000);
    reference.sort(lexicographic);
    expect(drain(heap)).toEqual(reference);
  });

  it('survives interleaved pushes and pops', () => {
    const rand = mulberry32(99);
    const heap = new BinaryHeap(8);
    const model: Array<[number, number]> = [];
    let nextId = 0;

    for (let step = 0; step < 20000; step++) {
      if (model.length === 0 || rand() < 0.6) {
        const key = Math.floor(rand() * 500);
        heap.push(key, nextId);
        model.push([key, nextId]);
        nextId++;
      } else {
        model.sort(lexicographic);
        const want = model.shift()!;
        expect(heap.pop()).toBe(true);
        expect([heap.topKey, heap.topId]).toEqual(want);
      }
      expect(heap.size).toBe(model.length);
    }
  });

  it('handles duplicate (key, id) pairs, which lazy deletion produces constantly', () => {
    const heap = new BinaryHeap(2);
    for (let i = 0; i < 5; i++) heap.push(3, 11);
    expect(drain(heap)).toEqual([
      [3, 11], [3, 11], [3, 11], [3, 11], [3, 11],
    ]);
  });

  it('clears without reallocating', () => {
    const heap = new BinaryHeap(4);
    heap.push(1, 1);
    heap.push(2, 2);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBe(false);
    heap.push(5, 5);
    expect(drain(heap)).toEqual([[5, 5]]);
  });
});
