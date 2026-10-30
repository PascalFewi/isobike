import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { POI_INFO, POI_KINDS } from '../src/lib/pois.ts';

/** build/pois.py is the other half of the POI contract: same kinds, same zooms. */
const PY = readFileSync(new URL('../../build/pois.py', import.meta.url), 'utf8');

function pyBlock(name: string): string {
  const m = PY.match(new RegExp(`^${name}: Final[^=]*= [({]([^)}]*)[)}]`, 'm'));
  if (m === null) throw new Error(`${name} not found in build/pois.py`);
  return m[1];
}

describe('POI kinds match the build', () => {
  it('lists the same kinds in the same order', () => {
    const kinds = [...pyBlock('POI_KINDS').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual([...POI_KINDS]);
  });

  it('shows each kind from the zoom its tiles start at', () => {
    const zooms = Object.fromEntries(
      [...pyBlock('KIND_MINZOOM').matchAll(/"([a-z_]+)": (\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(zooms).toEqual(Object.fromEntries(POI_KINDS.map((k) => [k, POI_INFO[k].minzoom])));
  });
});
