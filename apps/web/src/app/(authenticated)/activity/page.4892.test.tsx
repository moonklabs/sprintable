// @vitest-environment jsdom
//
// story 4892 (UI-9 활동) — the two views (감사 로그 | 팀 활동) are one named group of ds buttons (was two underline tabs); the open one is aria-current.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'p1' }) }));
vi.mock('@/components/activity/activity-log-view', () => ({ ActivityLogView: () => <div data-testid="audit-view" /> }));
vi.mock('@/components/activity/team-activity-view', () => ({ TeamActivityView: () => <div data-testid="team-view" /> }));

import ActivityPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ActivityPage /></NextIntlClientProvider>);
  });
}
const buttons = () => [...container.querySelectorAll('[role="group"] button')] as HTMLButtonElement[];

describe('ActivityPage — 두 보기 전환 (4892)', () => {
  it('⭐one named group of two ds buttons; the audit view is open first', async () => {
    await mount();
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(koMessages.teamActivity.tabsLabel);
    expect(buttons().map((b) => b.textContent)).toEqual([koMessages.teamActivity.tabAudit, koMessages.teamActivity.tabTeamActivity]);
    for (const b of buttons()) expect(b.getAttribute('data-slot')).toBe('ds-button');
    expect(buttons().map((b) => b.getAttribute('aria-current'))).toEqual(['page', null]);
    expect(container.querySelector('[data-testid="audit-view"]')).toBeTruthy();
  });

  it('⭐pressing the other side switches the view and moves aria-current', async () => {
    await mount();
    await act(async () => { buttons()[1]!.click(); });
    expect(buttons().map((b) => b.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(container.querySelector('[data-testid="team-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="audit-view"]')).toBeNull();
  });
});
