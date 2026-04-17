import { describe, expect, it } from 'vitest';
import { shouldPersistInlinePanelState } from './contextual-panel-layout';

describe('shouldPersistInlinePanelState', () => {
  it('persists only when a project-scoped storage key exists', () => {
    expect(shouldPersistInlinePanelState('panel:project-b')).toBe(true);
    expect(shouldPersistInlinePanelState(undefined)).toBe(false);
  });
});
