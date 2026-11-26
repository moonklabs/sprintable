// story 5034 (C4) — how the chat and the reading panel share the row. Red when: the expanded mode stops giving the panel the rest of the row · the chat is hidden or squeezed below a readable
// column while the panel is the window · the normal rule (the shell lane's) changes with this file.
import { describe, expect, it } from 'vitest';
import { CHAT_BESIDE_WIDTH, SIDE_PANEL_WIDTH, SIDE_PANEL_WIDTH_RAIL_FOLDED, readingPanelLayout } from './reading-panel-layout';

describe('readingPanelLayout', () => {
  it('normal (not expanded) is what chat-view always did: no inline style while the open-panel flag is set (classes decide), else the side width', () => {
    expect(readingPanelLayout({ expanded: false, railMode: 'normal', isMobileReadingView: true })).toEqual({ panelStyle: undefined, chatStyle: undefined });
    expect(readingPanelLayout({ expanded: false, railMode: 'normal', isMobileReadingView: false }).panelStyle).toEqual({ width: SIDE_PANEL_WIDTH, flexShrink: 0 });
    expect(readingPanelLayout({ expanded: false, railMode: 'folded', isMobileReadingView: false }).panelStyle).toEqual({ width: SIDE_PANEL_WIDTH_RAIL_FOLDED, flexShrink: 0 });
    // the numbers themselves are the shell lane's rule — written out here so a change of them is a decision, not a side effect
    expect(SIDE_PANEL_WIDTH).toBe('clamp(480px, 40vw, 720px)');
    expect(SIDE_PANEL_WIDTH_RAIL_FOLDED).toBe('480px');
  });
  it('expanded: the panel takes the rest of the row, the chat keeps a column of its own beside it (never hidden, never the whole row)', () => {
    for (const mobile of [true, false]) for (const railMode of ['normal', 'folded']) {
      const l = readingPanelLayout({ expanded: true, railMode, isMobileReadingView: mobile });
      expect(l.panelStyle).toEqual({ flex: '1 1 0%', minWidth: 0 });
      expect(l.chatStyle).toEqual({ flex: '0 0 auto', width: CHAT_BESIDE_WIDTH });
    }
  });
  it('the chat column beside the panel is a readable width (320–400) — a number someone may change on purpose, not by accident', () => {
    expect(CHAT_BESIDE_WIDTH).toBe('clamp(320px, 28vw, 400px)');
  });
});
