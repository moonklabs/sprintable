// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면, 유나 ds DateNav 5566) — 스탠드업의 손으로 만든 «← 날짜 → 오늘» 줄을 ds DateNav로 갈아 끼웠다.
// 못박는 것: 화살표는 «이름 있는» ds 단추(폰 44) · 날짜 칸은 이름이 있다(예전엔 없었다) · 화살표가 하루씩 옮긴다 · 칸을 직접 고르면 그 날 · «오늘»이 팀의 오늘로 되돌린다 ·
// 하루를 아직 모르면(시간대 모름) 칸 · 화살표가 잠기고 아무것도 읽지 않는다(story #4443 PR3a) · 고른 날로 읽기 주소가 바뀐다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock, tzMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), tzMock: { value: 'Asia/Seoul' as string | null } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/viewer-time-zone', async (orig) => ({ ...(await orig<typeof import('@/components/viewer-time-zone')>()), useViewerTimeZone: () => tzMock.value }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-board-card', () => ({ StandupBoardCard: () => null }));
vi.mock('@/components/standup/standup-feedback-dialog', () => ({ StandupFeedbackDialog: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const entryDates = () => vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/standup?date=')).map((u) => new URL(u, 'http://x').searchParams.get('date'));

beforeEach(() => {
  tzMock.value = 'Asia/Seoul';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T03:00:00Z')); // Seoul 12:00 on 11-10
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgTimezone: 'Asia/Seoul' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [] }) };
    if (typeof url === 'string' && (url.includes('/api/team-members') || url.includes('/api/sprints') || url.includes('/api/standup/feedback') || url.includes('/api/standup/missing') || url.includes('/api/stories'))) return { ok: true, json: async () => ({ data: [], meta: {} }) };
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StandupPage projectId="proj-1" /></NextIntlClientProvider>); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
// 날짜 줄은 데스크톱(상단바)과 폰(위 줄) 두 곳에 같은 부품으로 그려진다 — 화면에 보이는 쪽은 CSS가 가르므로 첫 줄을 쓴다.
const navs = () => [...container.querySelectorAll<HTMLElement>('[data-slot="ds-date-nav"]')];
const nav = () => navs()[0]!;
const dateInput = () => nav().querySelector('input[type="date"]') as HTMLInputElement;
const btn = (label: string) => [...nav().querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement | undefined;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('StandupClient — 날짜 줄은 ds DateNav(story #4888)', () => {
  it('⭐날짜 줄이 ds DateNav다 — 이름 있는 화살표(어제 · 내일) · 이름 있는 날짜 칸(«날짜») · «오늘» · 폰 44 클래스', async () => {
    await mount();
    expect(navs().length).toBeGreaterThanOrEqual(1);
    expect(dateInput().getAttribute('aria-label')).toBe(koMessages.standup.dateLabel);
    expect(dateInput().value).toBe('2026-11-10');
    for (const label of [koMessages.standup.previousDay, koMessages.standup.nextDay]) {
      const b = btn(label)!;
      expect(b, label).toBeTruthy();
      expect(b.getAttribute('data-slot')).toBe('ds-icon-button');
      expect(b.className.split(/\s+/)).toContain('pointer-coarse:min-h-11');
    }
    expect(btn(koMessages.standup.today)).toBeTruthy();
    expect(dateInput().className.split(/\s+/)).toContain('pointer-coarse:h-11');
    // 예전 글자 단추(←/→)는 없다
    expect([...nav().querySelectorAll('button')].map((b) => b.textContent)).not.toContain('←');
  });

  it('⭐화살표가 하루씩 옮기고 그 날의 체크인을 읽는다 · «오늘»이 팀의 오늘로 돌아간다', async () => {
    await mount();
    expect(entryDates()).toContain('2026-11-10');
    await click(btn(koMessages.standup.previousDay)!);
    expect(dateInput().value).toBe('2026-11-09');
    expect(entryDates()).toContain('2026-11-09');
    await click(btn(koMessages.standup.previousDay)!);
    expect(dateInput().value).toBe('2026-11-08');
    await click(btn(koMessages.standup.nextDay)!);
    expect(dateInput().value).toBe('2026-11-09');
    await click(btn(koMessages.standup.today)!);
    expect(dateInput().value).toBe('2026-11-10');
  });

  it('⭐칸에서 직접 고른 날로 간다(그 날의 체크인을 읽는다) · 월 경계도 화살표가 맞게 넘는다', async () => {
    await mount();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(dateInput(), '2026-10-31');
      dateInput().dispatchEvent(new Event('input', { bubbles: true }));
      dateInput().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dateInput().value).toBe('2026-10-31');
    expect(entryDates()).toContain('2026-10-31');
    await click(btn(koMessages.standup.nextDay)!);
    expect(dateInput().value).toBe('2026-11-01');
  });

  it('⭐하루를 아직 모르면(시간대 모름) 칸 · 화살표가 잠기고 아무것도 읽지 않는다 — «NaN-NaN-NaN»을 만들지 않는다(story #4443 PR3a)', async () => {
    tzMock.value = null;
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgTimezone: null });
    await mount();
    expect(dateInput().value).toBe('');
    expect(dateInput().disabled).toBe(true);
    expect(btn(koMessages.standup.previousDay)!.disabled).toBe(true);
    expect(btn(koMessages.standup.nextDay)!.disabled).toBe(true);
    expect(entryDates()).toHaveLength(0);
    expect(container.innerHTML).not.toContain('NaN');
  });
});
