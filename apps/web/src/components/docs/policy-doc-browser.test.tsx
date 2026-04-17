import { describe, expect, it } from 'vitest';
import { shouldClosePolicyPanelAfterSelection } from './policy-doc-browser';

describe('shouldClosePolicyPanelAfterSelection', () => {
  it('keeps inline panels open after selection', () => {
    expect(shouldClosePolicyPanelAfterSelection('inline')).toBe(false);
  });

  it('closes drawer panels after selection so content stays primary', () => {
    expect(shouldClosePolicyPanelAfterSelection('drawer')).toBe(true);
  });
});
