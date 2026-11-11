// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면 본체 넷째 조각) — 스프린트 상세 패널의 번다운 블록: 손으로 만든 수치 타일 셋(rounded-md border bg-muted/30) · 이상선/실제선 상자 · 상세 안의 «리포트 보기» 상자 링크를 ds 부품으로.
// 완료율 · SP · 스토리 = ds Metric(값 · «/ 한도»), 진행 바 = 토큰 + role=progressbar(이름 · 값), 이상선/실제선 = Chip, «리포트 보기» = ds Button(링크, 폰 44).
// 새 데이터 0 · 값 · 조건(번다운이 있을 때만, 이상선은 있을 때만, 리포트는 report_doc_id가 있을 때만)은 그대로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (<div>{title}{actions}</div>),
}));
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({ WorkspaceFrameTabs: () => null }));
vi.mock('../standup/standup-client', () => ({ default: () => null }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const S = koMessages.sprints;
const SPRINT = { id: 's1', title: '번다운 스프린트', status: 'active', start_date: '2026-07-01', end_date: '2026-07-14', report_doc_id: 'doc-9' };
const BURNDOWN = {
  total_points: 10, done_points: 4, remaining_points: 6, completion_pct: 40, stories_count: 5, done_count: 2,
  ideal_line: [{ date: '2026-07-01', points: 10 }, { date: '2026-07-14', points: 0 }],
  actual_line: [{ date: '2026-07-01', points: 10 }, { date: '2026-07-10', points: 6 }],
};
let burndownResponse: () => { ok: boolean; json: () => Promise<unknown> };
let sprintRow: Record<string, unknown> = SPRINT;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  burndownResponse = () => ({ ok: true, json: async () => ({ data: BURNDOWN }) });
  sprintRow = SPRINT;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [sprintRow] }) };
    if (url.includes('/burndown')) return burndownResponse();
    if (url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SprintsClient projectId="proj-1" orgId="org-1" /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
async function openDetail() {
  await mount();
  const li = [...container.querySelectorAll('li')].find((x) => x.textContent?.includes('번다운 스프린트'))!;
  await act(async () => { li.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}
const detail = () => container.querySelector('h2')?.closest('div.flex-col') as HTMLElement;
const metrics = () => [...detail().querySelectorAll('[data-slot="ds-metric"]')].map((m) => (m.textContent ?? '').replace(/\s+/g, ' ').trim());

describe('스프린트 상세 패널 번다운 — ds 부품(story #4888)', () => {
  it('⭐완료율 · SP · 스토리가 ds Metric 셋이고 값이 그대로다(40% · 4 / 10 · 2 / 5)', async () => {
    await openDetail();
    const m = metrics();
    expect(m).toHaveLength(3);
    expect(m.some((x) => x.includes(S.completionRate) && x.includes('40%'))).toBe(true);
    expect(m.some((x) => x.startsWith('SP') && x.includes('4') && x.includes('/ 10'))).toBe(true);
    expect(m.some((x) => x.includes(S.stories) && x.includes('2') && x.includes('/ 5'))).toBe(true);
  });

  it('⭐진행 바가 role=progressbar이고 이름(완료율)과 값(40)을 말한다 — 예전엔 보이기만 했다', async () => {
    await openDetail();
    const bar = detail().querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('aria-label')).toBe(S.completionRate);
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('40%');
  });

  it('⭐이상선 · 실제선이 칩 둘이고 값이 그대로다(10 → 0 · 10 → 6), 이상선이 없으면 칩도 없다', async () => {
    await openDetail();
    const chips = [...detail().querySelectorAll('[data-slot="ds-chip"]')].map((c) => (c.textContent ?? '').trim());
    expect(chips).toContain(`${S.idealLine}: 10 → 0`);
    expect(chips).toContain(`${S.actualLine}: 10 → 6`);
  });

  it('이상선이 비어 있으면 이상선 · 실제선 칩이 나오지 않는다(예전과 같은 조건)', async () => {
    burndownResponse = () => ({ ok: true, json: async () => ({ data: { ...BURNDOWN, ideal_line: [], actual_line: [] } }) });
    await openDetail();
    expect(metrics()).toHaveLength(3);
    expect([...detail().querySelectorAll('[data-slot="ds-chip"]')].some((c) => (c.textContent ?? '').includes(S.idealLine))).toBe(false);
  });

  it('⭐손으로 만든 타일 · 상자(rounded-md border bg-muted/30 · border p-3 · border-primary/30)가 번다운 블록에 없다', async () => {
    await openDetail();
    expect(detail().querySelectorAll('div.bg-muted\\/30')).toHaveLength(0);
    expect(detail().querySelectorAll('[class*="border-primary/30"]')).toHaveLength(0);
    expect(detail().querySelectorAll('div.rounded-md.border.p-3')).toHaveLength(0);
  });

  it('⭐상세 안의 «리포트 보기»가 ds Button 링크(폰 44)이고 주소가 그대로다', async () => {
    await openDetail();
    const link = [...detail().querySelectorAll('a')].find((a) => (a.textContent ?? '').includes(S.viewReport)) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('data-slot')).toBe('ds-button');
    expect(link.getAttribute('href')).toContain('/docs?id=doc-9');
    expect(link.className.split(/\s+/)).toContain('touch:min-h-ds-touch');
  });

  it('⭐리포트가 없는 스프린트(report_doc_id 없음)에는 상세 안 «리포트 보기»가 없다 — 예전과 같은 조건', async () => {
    sprintRow = { ...SPRINT, report_doc_id: undefined };
    await openDetail();
    expect(metrics()).toHaveLength(3);
    expect([...detail().querySelectorAll('a')].some((a) => (a.textContent ?? '').includes(S.viewReport))).toBe(false);
  });

  it('⭐번다운을 못 읽으면(HTTP 실패) 번다운 블록이 통째로 없다 — 예전과 같다', async () => {
    burndownResponse = () => ({ ok: false, json: async () => null });
    await openDetail();
    expect(metrics()).toHaveLength(0);
    expect(detail().querySelector('[role="progressbar"]')).toBeNull();
  });
});
