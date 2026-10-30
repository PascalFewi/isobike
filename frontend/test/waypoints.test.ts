import { describe, expect, it } from 'vitest';

import { dropIndex, moveItem, outAndBack } from '../src/lib/waypoints.ts';

describe('outAndBack', () => {
  let key = 100;
  const copy = (w: { key: number; name: string }) => ({ ...w, key: key++ });

  it('appends the way back through the same points, as new waypoints', () => {
    const ws = [{ key: 1, name: 'A' }, { key: 2, name: 'B' }, { key: 3, name: 'C' }];
    const out = outAndBack(ws, copy);
    expect(out.map((w) => w.name)).toEqual(['A', 'B', 'C', 'B', 'A']);
    expect(new Set(out.map((w) => w.key)).size).toBe(out.length);
  });

  it('leaves a list without a route alone', () => {
    expect(outAndBack([{ key: 1, name: 'A' }], copy).map((w) => w.name)).toEqual(['A']);
    expect(outAndBack([], copy)).toEqual([]);
  });
});

describe('moveItem / dropIndex', () => {
  it('moves one item and keeps the rest in order', () => {
    expect(moveItem(['A', 'B', 'C', 'D'], 0, 2)).toEqual(['B', 'C', 'A', 'D']);
    expect(moveItem(['A', 'B', 'C', 'D'], 3, 0)).toEqual(['D', 'A', 'B', 'C']);
    expect(moveItem(['A', 'B', 'C'], 1, 1)).toEqual(['A', 'B', 'C']);
  });

  it('drops where the pointer is between the other rows', () => {
    const centres = [10, 30, 50, 70]; // rows A..D
    expect(dropIndex(centres, 0, 5)).toBe(0); // A above everything: stays first
    expect(dropIndex(centres, 0, 40)).toBe(1); // A between B and C
    expect(dropIndex(centres, 0, 99)).toBe(3); // A to the end
    expect(dropIndex(centres, 3, 20)).toBe(1); // D between A and B
    expect(moveItem(['A', 'B', 'C', 'D'], 3, dropIndex(centres, 3, 20))).toEqual(['A', 'D', 'B', 'C']);
  });
});
