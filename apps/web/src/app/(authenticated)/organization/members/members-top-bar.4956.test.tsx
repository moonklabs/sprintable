// @vitest-environment jsdom
//
// story 4956 (desktop hands) — the 구성원 screen's top bar says «구성원» like its «팀» siblings (에이전트 · 실행 기록 · API 키): the loading fallback and the screen fill the slot with the SAME component (same words · same context chip), so the bar is never empty and does not blink on arrival.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';

const nav = vi.hoisted(() => ({ pathname: '/organization/members' as string }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => nav.pathname,
  useSelectedLayoutSegments: () => ['organization', 'members'],
  useParams: () => ({}),
  useRouter: () => ({ prefetch: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', role: 'owner' }] }),
}));
vi.mock('@/components/settings/org-members-section', () => ({ OrgMembersSection: () => <div data-testid="members-section" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function Probe() {
  const { title, showContextChip } = useTopBar();
  return <div data-testid="topbar-title" data-chip={String(showContextChip)}>{title}</div>;
}
async function render(node: React.ReactNode) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><Probe />{node}</TopBarProvider></NextIntlClientProvider>); });
}
const probe = () => container.querySelector('[data-testid="topbar-title"]') as HTMLElement;

describe('[SID:4956] 구성원 top bar title', () => {
  it('⭐the loading fallback says «구성원» with the context chip', async () => {
    const { default: Loading } = await import('./loading');
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.nav.orgMembers); // reverted (no table row / no fallback) → '' → RED
    expect(probe().dataset.chip).toBe('true');
  });

  it('⭐the screen fills the slot with the same title (same words · same chip as the fallback)', async () => {
    const { default: Loading } = await import('./loading');
    await render(<Loading />);
    const fallbackHtml = probe().innerHTML;
    const { default: Page } = await import('./page');
    await render(<Page />);
    expect(container.querySelector('[data-testid="members-section"]')).toBeTruthy();
    expect(probe().innerHTML).toBe(fallbackHtml);
    expect(probe().textContent).toBe(koMessages.nav.orgMembers);
    expect(probe().dataset.chip).toBe('true');
  });
});
