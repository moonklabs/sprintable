import type { CSSProperties } from 'react';

/**
 * story 5034 (C4) — the third tier of a chat card: card → side panel → the WHOLE WINDOW, with the chat staying beside. One pure function says how the two columns share the row, so the rule
 * is one place and one test (chat-view.tsx only applies what it says). Width numbers of the normal side panel are the shell lane's rule (C1 · 2b) — carried over here unchanged; this adds only
 * the `expanded` mode: the panel takes the rest of the row and the chat keeps a column of its own (never hidden, never narrower than a message can be read).
 * On a phone the panel is already the whole screen (the chat is hidden behind it, below `lg`) — `expanded` changes nothing there.
 * `isMobileReadingView` is chat-view's own flag, passed through as it is: it is «a panel is open», and the normal rule is applied exactly as before this file existed (it gives no inline
 * style while that flag is set). The expanded mode does not depend on it — its two columns are plain flex values that mean the same on a phone.
 */
export type RailMode = 'normal' | string;

export interface ReadingPanelLayout {
  /** the panel's own column · `undefined` = no inline style (the phone's full-screen view) */
  panelStyle: CSSProperties | undefined;
  /** the chat column's inline style · `undefined` = the usual `flex-1` column */
  chatStyle: CSSProperties | undefined;
}

export const SIDE_PANEL_WIDTH = 'clamp(480px, 40vw, 720px)';
export const SIDE_PANEL_WIDTH_RAIL_FOLDED = '480px';
/** the chat's column while the panel is the whole window — wide enough for a message line, narrow enough that the panel is the window */
export const CHAT_BESIDE_WIDTH = 'clamp(320px, 28vw, 400px)';

export function readingPanelLayout(o: { expanded: boolean; railMode: RailMode; isMobileReadingView: boolean }): ReadingPanelLayout {
  if (o.expanded) return { panelStyle: { flex: '1 1 0%', minWidth: 0 }, chatStyle: { flex: '0 0 auto', width: CHAT_BESIDE_WIDTH } };
  if (o.isMobileReadingView) return { panelStyle: undefined, chatStyle: undefined };
  return { panelStyle: { width: o.railMode === 'normal' ? SIDE_PANEL_WIDTH : SIDE_PANEL_WIDTH_RAIL_FOLDED, flexShrink: 0 }, chatStyle: undefined };
}
