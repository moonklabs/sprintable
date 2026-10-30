// story 4822 — the run-time switch of the usage-record tag. Unset / empty / an explicit «no» keep the tag as built; anything else that is set turns it
// off — so a typo stops the sending instead of leaving it on (the safe direction for a privacy switch).
import { describe, expect, it } from 'vitest';
import { ANALYTICS_SWITCH_ENV, analyticsDisabled } from './analytics-switch';

describe('analyticsDisabled', () => {
  it('the switch is the variable DISABLE_ANALYTICS', () => {
    expect(ANALYTICS_SWITCH_ENV).toBe('DISABLE_ANALYTICS');
  });

  it.each(['true', 'TRUE', 'True', '1', 'yes', 'on', ' true ', 'ture', 'disabled', '2', 'x'])('«%s» turns the tag off', (v) => {
    expect(analyticsDisabled({ DISABLE_ANALYTICS: v })).toBe(true);
  });

  it.each([undefined, '', '   ', '0', 'false', 'FALSE', 'no', 'off', 'n', ' False '])('«%s» leaves the tag as built', (v) => {
    expect(analyticsDisabled({ DISABLE_ANALYTICS: v })).toBe(false);
  });

  it('reads the variable named DISABLE_ANALYTICS only (a neighbour with a similar name does nothing)', () => {
    expect(analyticsDisabled({ NEXT_PUBLIC_DISABLE_ANALYTICS: 'true', ANALYTICS_DISABLED: 'true', DO_NOT_TRACK: '1' })).toBe(false);
  });

  it('with no argument it reads the process environment, at the moment of the call', () => {
    const before = process.env.DISABLE_ANALYTICS;
    try {
      delete process.env.DISABLE_ANALYTICS;
      expect(analyticsDisabled()).toBe(false);
      process.env.DISABLE_ANALYTICS = 'true';
      expect(analyticsDisabled()).toBe(true);
      process.env.DISABLE_ANALYTICS = 'false';
      expect(analyticsDisabled()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DISABLE_ANALYTICS; else process.env.DISABLE_ANALYTICS = before;
    }
  });
});
