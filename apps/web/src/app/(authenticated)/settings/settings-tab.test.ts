// [SID:4680] resolveSettingsTab: ?tab=billing where billing is closed (prod today) is the default tab, not an empty pane; where it is open, the tab as asked.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS_TAB, HIDDEN_SETTINGS_TABS, resolveSettingsTab } from './settings-tab';

const open = { supportWidget: true, billing: true };
const closed = { supportWidget: false, billing: false };

describe('[4680] the settings tab from the address', () => {
  it('billing closed → the default tab (no empty pane) · billing open → billing', () => {
    expect(resolveSettingsTab('billing', closed)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('billing', { supportWidget: true, billing: false })).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('billing', open)).toBe('billing');
    expect(resolveSettingsTab('billing', { supportWidget: false, billing: true })).toBe('billing');
  });
  it('the other tabs do not depend on billing', () => {
    for (const tab of ['profile', 'appearance', 'notifications', 'desktop', 'members', 'api-keys', 'workflow-policies']) {
      expect(resolveSettingsTab(tab, closed), tab).toBe(tab);
    }
  });
  it('the older gates stay: hidden tabs and support (flag off) → default · no tab → default', () => {
    for (const tab of HIDDEN_SETTINGS_TABS) expect(resolveSettingsTab(tab, open), tab).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('support', { supportWidget: false, billing: true })).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('support', open)).toBe('support');
    expect(resolveSettingsTab(null, open)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('', open)).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('story 4762 — the «이 폰» tab exists only in the phone app: ?tab=this-phone elsewhere falls back to the default tab', () => {
    expect(resolveSettingsTab('this-phone', open)).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('this-phone', { ...open, phoneApp: false })).toBe(DEFAULT_SETTINGS_TAB);
    expect(resolveSettingsTab('this-phone', { ...open, phoneApp: true })).toBe('this-phone');
  });
});
