/**
 * Waypoint list edits that are more than one line: kept pure so they are tested
 * without the app around them.
 */

/**
 * "Hin und zurück": the same way back. A, B, C becomes A, B, C, B, A -- every
 * point but the last appended in reverse, each as a new waypoint (`copy` gives
 * it its own key), so the legs back are routed through the same places.
 */
export function outAndBack<T>(waypoints: readonly T[], copy: (w: T) => T): T[] {
  if (waypoints.length < 2) return [...waypoints];
  return [...waypoints, ...waypoints.slice(0, -1).reverse().map(copy)];
}

/** The list with the item at `from` taken out and put back at index `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/**
 * Where a dragged row lands: its index in the reordered list, from the other
 * rows' vertical centres (in list order) and the pointer's y -- the count of
 * other rows whose centre lies above the pointer.
 */
export function dropIndex(centres: readonly number[], from: number, y: number): number {
  let to = 0;
  centres.forEach((c, i) => {
    if (i !== from && c < y) to++;
  });
  return to;
}
