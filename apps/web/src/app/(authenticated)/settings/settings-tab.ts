// The settings page's tab from `?tab=` — pure, so a deep link to a tab this deployment does not draw can be tested (a tab with no trigger and no content is an empty pane).
export const HIDDEN_SETTINGS_TABS = new Set<string>(['ai', 'workflow', 'org-members']);
export const DEFAULT_SETTINGS_TAB = 'profile';

/** which gated tabs this deployment draws */
export interface SettingsTabGates {
  /** isSupportWidgetEnabled() */
  supportWidget: boolean;
  /** isEEEnabled() — the billing tab (trigger and content) exists */
  billing: boolean;
  /** story 4762 — inside the phone app: the «이 폰» tab exists (it shows the phone's own check number — nothing to show anywhere else). Absent = not the phone app. */
  phoneApp?: boolean;
}

// ?tab= 딥링크가 숨김 탭을 가리키면 기본 탭으로 폴백 (빈 화면 방지).
// story #3274 — support 탭은 isSupportWidgetEnabled() 뒤(prod는 아직 false)라 flag off일
// 때 ?tab=support로 직접 들어오면 트리거/콘텐츠가 아예 안 그려져 빈 화면이 된다 — 그
// 경우도 기본 탭으로 폴백.
// story 4680: the billing tab is drawn only where billing is open (isEEEnabled()) — a link or an old bookmark to ?tab=billing elsewhere (prod today)
// would leave an empty pane; the default tab it is.
export function resolveSettingsTab(tab: string | null, gates: SettingsTabGates): string {
  if (!tab || HIDDEN_SETTINGS_TABS.has(tab)) return DEFAULT_SETTINGS_TAB;
  if (tab === 'support' && !gates.supportWidget) return DEFAULT_SETTINGS_TAB;
  if (tab === 'billing' && !gates.billing) return DEFAULT_SETTINGS_TAB;
  if (tab === 'this-phone' && !gates.phoneApp) return DEFAULT_SETTINGS_TAB; // a link to the phone's tab opened in a browser would be an empty pane
  return tab;
}
