// story #4487 — every key this web app keeps in the browser's sessionStorage / localStorage, and whether it belongs to the
// signed-in account or stays with the device. A sign-out, an account switch and adding an account clear the account's
// keys (clearAccountScopedStorage) — a value that would flow into the next account's screen or requests, or that holds a
// person's words or state, must not outlive the account (the desktop setup's «결과 보기» carried the previous account's
// project id — ⓓ capture 6). View settings inside one project stay: the next account cannot open that project, and the
// same person signing in again keeps their board and docs settings (PO 03:13Z).
//
// browser-storage-keys.guard.test.ts keeps this list complete: every file that calls the storage API must be named here, and
// every key it spells must match an entry — a new key cannot slip in without a scope.

export type StorageArea = 'session' | 'local';

export interface StorageKeyEntry {
  /** the key, or its fixed head when `prefix` */
  key: string;
  prefix?: true;
  area: StorageArea;
  /** account: cleared on sign-out · switch · add · kept: stays with the device */
  scope: 'account' | 'kept';
  /** the files (under apps/web/src) that use it */
  where: string[];
}

export const BROWSER_STORAGE_KEYS: readonly StorageKeyEntry[] = [
  // ── account: flows into the next account's screen or requests, or holds a person's words · state ──
  { key: 'sprintable_tab_project_id', area: 'session', scope: 'account',
    where: ['app/dashboard/dashboard-shell.tsx', 'lib/project-context-client.ts', 'components/nav/org-hint-banner.tsx', 'hooks/use-unified-switcher.ts'] },
  { key: 'sprintable:field-draft:v1:', prefix: true, area: 'session', scope: 'account', where: ['hooks/use-field-draft.ts'] },
  { key: 'sp_onboarding_org_draft:', prefix: true, area: 'session', scope: 'account', where: ['app/onboarding/onboarding-form.tsx'] },
  { key: 'sprintable_onboarding_session_id', area: 'session', scope: 'account', where: ['app/onboarding/onboarding-telemetry.ts'] },
  { key: 'sprintable_pending_toast', area: 'session', scope: 'account', where: ['components/chat/cross-project-toast-provider.tsx'] },
  // dismissed banners carry no organization in the key — kept, they would hide the next account's banner
  { key: 'au-usage-warn-dismissed-band', area: 'session', scope: 'account', where: ['ee/components/billing/au-usage-banner.tsx'] },
  { key: 'storage-capacity-toast-shown', area: 'session', scope: 'account', where: ['components/storage/storage-capacity-toast-provider.tsx'] },
  { key: 'storage-capacity-warn-dismissed', area: 'session', scope: 'account', where: ['components/storage/storage-capacity-banner.tsx'] },
  { key: 'sprintable:chat-draft:', prefix: true, area: 'local', scope: 'account', where: ['components/chat/chat-input.tsx'] },
  { key: 'steer-recipients:', prefix: true, area: 'local', scope: 'account', where: ['app/(authenticated)/[ws]/[proj]/goals/steer-dispatch-modal.tsx'] },
  { key: 'docs:recents:', prefix: true, area: 'local', scope: 'account', where: ['components/docs/use-recent-docs.ts'] },
  { key: 'sprintable_activation_checklist_complete', prefix: true, area: 'local', scope: 'account', where: ['hooks/use-activation-status.ts'] },
  { key: 'sprintable:intent-suggestion:dismissed', prefix: true, area: 'local', scope: 'account', where: ['lib/intent-suggestion-dismissal.ts'] },
  { key: 'sprintable:reference-candidates:rejected', prefix: true, area: 'local', scope: 'account', where: ['lib/reference-candidates.ts'] },

  // ── kept: view settings inside one project · device layout · per-person keys · in-flight payment (its own card, 4488) ──
  { key: 'board_axis_mode_', prefix: true, area: 'local', scope: 'kept', where: ['components/kanban/kanban-board.tsx'] },
  { key: 'done_collapsed_', prefix: true, area: 'local', scope: 'kept', where: ['components/kanban/kanban-board.tsx'] },
  { key: 'wip_limit_', prefix: true, area: 'local', scope: 'kept', where: ['components/kanban/kanban-board.tsx'] },
  { key: 'epic_swimlane_axis_mode_', prefix: true, area: 'local', scope: 'kept', where: ['components/epics/epic-swimlane-board.tsx'] },
  { key: 'docs-sort-mode:', prefix: true, area: 'local', scope: 'kept', where: ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx'] },
  { key: 'docs-view-mode:', prefix: true, area: 'local', scope: 'kept', where: ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx'] },
  { key: 'docs-sidebar-collapsed', area: 'local', scope: 'kept', where: ['app/(authenticated)/[ws]/[proj]/docs/docs-client-layout.tsx'] },
  { key: 'docs:tree:expanded:', prefix: true, area: 'local', scope: 'kept', where: ['components/docs/use-tree-expanded.ts'] },
  { key: 'docs:policy-sprints-panel:', prefix: true, area: 'local', scope: 'kept', where: ['components/docs/policy-doc-browser.tsx', 'components/ui/contextual-panel-layout.tsx'] },
  { key: 'team-presence', area: 'local', scope: 'kept', where: ['app/dashboard/dashboard-shell.tsx', 'components/ui/contextual-panel-layout.tsx'] },
  { key: 'storage-detail', area: 'local', scope: 'kept', where: ['components/storage/storage-view.tsx', 'components/ui/contextual-panel-layout.tsx'] },
  { key: 'sidebar_width', area: 'local', scope: 'kept', where: ['components/ui/sidebar.tsx'] },
  { key: 'sidebar_group_collapsed', area: 'local', scope: 'kept', where: ['components/nav/app-sidebar.tsx'] },
  { key: 'sprintable-flow-canvas-lane-count', area: 'local', scope: 'kept', where: ['components/flow/flow-canvas-resize-pane.tsx'] },
  { key: 'sprintable:refresh_interval_ms', area: 'local', scope: 'kept', where: ['contexts/refresh-context.tsx'] },
  { key: 'sp_reopen_once_url', area: 'session', scope: 'kept', where: ['lib/hard-reload.ts'] },
  { key: 'sprintable.releaseNotes.seen.', prefix: true, area: 'local', scope: 'kept', where: ['components/release-notes/release-notes-gate.tsx'] },
  { key: 'sprintable.billing.paymentAttempt', prefix: true, area: 'local', scope: 'kept', where: ['ee/components/billing/payment-attempt.ts'] },
];

function matches(entry: StorageKeyEntry, key: string): boolean {
  return entry.prefix ? key.startsWith(entry.key) : key === entry.key;
}

/** The account's keys this browser holds now, cleared from both stores. Kept keys (and anything unknown) stay. */
export function clearAccountScopedStorage(): void {
  if (typeof window === 'undefined') return;
  for (const area of ['session', 'local'] as const) {
    let store: Storage;
    try {
      store = area === 'session' ? window.sessionStorage : window.localStorage;
    } catch {
      continue; // storage blocked (a private window): nothing was kept there
    }
    const entries = BROWSER_STORAGE_KEYS.filter((e) => e.area === area && e.scope === 'account');
    const doomed: string[] = [];
    try {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k !== null && entries.some((e) => matches(e, k))) doomed.push(k);
      }
    } catch {
      continue; // a store that cannot be listed must never stop the sign-out that called this
    }
    for (const k of doomed) {
      try { store.removeItem(k); } catch { /* best effort */ }
    }
  }
}
