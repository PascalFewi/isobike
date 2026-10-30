import { describe, expect, it } from 'vitest';

import { formLabel } from '../src/components/Controls.tsx';
import { FLAT_KMH_DEFAULT, FLAT_KMH_MAX, FLAT_KMH_MIN } from '../src/lib/profile.ts';

describe('formLabel', () => {
  it('names the whole slider range, from gemütlich to Profi', () => {
    expect(formLabel(FLAT_KMH_MIN)).toBe('gemütlich');
    expect(formLabel(FLAT_KMH_MAX)).toBe('Profi');
    expect(formLabel(FLAT_KMH_DEFAULT)).toBe('sportlich');
  });

  it('never goes down as the speed goes up', () => {
    const order = ['gemütlich', 'Hobby', 'sportlich', 'ambitioniert', 'Profi'];
    let last = 0;
    for (let kmh = FLAT_KMH_MIN; kmh <= FLAT_KMH_MAX; kmh++) {
      const i = order.indexOf(formLabel(kmh));
      expect(i).toBeGreaterThanOrEqual(last);
      last = i;
    }
  });
});
