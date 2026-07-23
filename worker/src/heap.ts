/**
 * Array-based binary min-heap over (key, nodeId) pairs.
 *
 * Two flat typed arrays, no per-entry objects: a nationwide Dijkstra pushes
 * millions of entries, and allocating a `{key, node}` for each is what turns a
 * few hundred milliseconds into a few seconds of GC.
 *
 * **Lazy deletion, not decrease-key.** Relaxing a node pushes a new entry rather
 * than repositioning the old one; stale entries are discarded on pop by the
 * caller's `settled` check. That costs memory (the heap can hold more entries
 * than there are nodes) but removes the node->heap-position index and all the
 * bookkeeping that goes with it. For a graph this sparse it is the standard
 * trade and the boring one.
 *
 * **Ordering is (key, nodeId) lexicographic** -- deliberately, not just by key.
 * Python's `heapq` compares the tuples `(cost, node)` the reference router pushes,
 * so matching that here is what makes equal-cost paths resolve identically in
 * both languages. Without it, a tie would be broken by insertion order, which
 * differs between implementations, and the golden path assertions would be flaky
 * rather than exact.
 */
export class BinaryHeap {
  private keys: Float64Array;
  private ids: Uint32Array;
  private count = 0;

  /** Key of the entry removed by the last successful {@link pop}. */
  public topKey = 0;
  /** Node id of the entry removed by the last successful {@link pop}. */
  public topId = 0;

  constructor(capacity = 1024) {
    const initial = Math.max(1, capacity);
    this.keys = new Float64Array(initial);
    this.ids = new Uint32Array(initial);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
  }

  push(key: number, id: number): void {
    if (this.count === this.keys.length) this.grow();
    let i = this.count++;
    const keys = this.keys;
    const ids = this.ids;

    // Sift up, moving the hole rather than swapping: one write per level.
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pk = keys[parent];
      if (pk < key || (pk === key && ids[parent] < id)) break;
      keys[i] = pk;
      ids[i] = ids[parent];
      i = parent;
    }
    keys[i] = key;
    ids[i] = id;
  }

  /**
   * Remove the smallest entry into {@link topKey} / {@link topId}.
   * Returns false when the heap is empty.
   */
  pop(): boolean {
    if (this.count === 0) return false;
    const keys = this.keys;
    const ids = this.ids;

    this.topKey = keys[0];
    this.topId = ids[0];

    const last = --this.count;
    if (last === 0) return true;

    const key = keys[last];
    const id = ids[last];
    let i = 0;
    const half = last >> 1;
    while (i < half) {
      let child = 2 * i + 1;
      const right = child + 1;
      if (
        right < last &&
        (keys[right] < keys[child] || (keys[right] === keys[child] && ids[right] < ids[child]))
      ) {
        child = right;
      }
      const ck = keys[child];
      if (key < ck || (key === ck && id < ids[child])) break;
      keys[i] = ck;
      ids[i] = ids[child];
      i = child;
    }
    keys[i] = key;
    ids[i] = id;
    return true;
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    const ids = new Uint32Array(this.ids.length * 2);
    keys.set(this.keys);
    ids.set(this.ids);
    this.keys = keys;
    this.ids = ids;
  }
}
