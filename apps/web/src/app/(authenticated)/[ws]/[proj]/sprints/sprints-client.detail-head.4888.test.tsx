// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면 본체 둘째 조각) — 스프린트 상세 패널의 머리: 삭제 · 닫기 아이콘 단추(옛 ghost sm = 높이 28, 폰 누름 영역 44 미만)와 계획 수치 칸(손으로 만든 rounded-md border 칩)을 ds 부품으로.
// 목록 줄의 «리포트 보기» 링크(text-xs 한 줄 — 폰 390에서 누름 높이 44 아래, PO 11-11 비차단 한 줄)도 폰 44로.
// 새 기능 0 · 삭제는 사람 전용 그대로 · 수치는 값이 있을 때만(예전과 같은 조건).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (<div data-testid="top-bar">{title}{actions}</div>),
}));
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({ WorkspaceFrameTabs: () => null }));
vi.mock('../standup/standup-client', () => ({ default: () => null }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const WITH_STATS = { id: 's1', title: '수치 있는 스프린트', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14', capacity: 20, team_size: 3, report_doc_id: 'doc-9' };
const NO_STATS = { id: 's2', title: '수치 없는 스프린트', status: 'active', start_date: '2026-08-01', end_date: '2026-08-14' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [WITH_STATS, NO_STATS] }) };
    if (typeof url === 'string' && url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
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
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const rowOf = (title: string) => [...container.querySelectorAll('li')].find((li) => li.textContent?.includes(title))!;
async function select(title: string) { await act(async () => { rowOf(title).dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); }
const detail = () => container.querySelector('h2')?.closest('div.flex-col') as HTMLElement | null;
const S = koMessages.sprints;

describe('스프린트 상세 패널 머리 — ds 부품(story #4888)', () => {
  it('⭐삭제 · 닫기가 ds 아이콘 단추(이름 있음 · 폰 누름 영역 44)다 — 옛 ghost sm(높이 28)이 아니다', async () => {
    await mount();
    await select('수치 있는 스프린트');
    for (const label of [S.delete, S.cancel]) {
      const b = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(b, label).not.toBeNull();
      expect(b.getAttribute('data-slot')).toBe('ds-icon-button');
      expect(b.className.split(/\s+/)).toContain('touch:min-h-11');
      expect(b.className.split(/\s+/)).toContain('touch:min-w-11');
    }
  });

  it('⭐닫기 단추를 누르면 상세가 닫힌다(동작 그대로)', async () => {
    await mount();
    await select('수치 있는 스프린트');
    expect(container.querySelector(`button[aria-label="${S.delete}"]`)).not.toBeNull();
    await act(async () => { (container.querySelector(`button[aria-label="${S.cancel}"]`) as HTMLButtonElement).click(); });
    await flush();
    expect(container.querySelector(`button[aria-label="${S.delete}"]`)).toBeNull();
  });

  it('⭐삭제는 사람 전용 그대로 — 에이전트에게는 삭제 단추가 없고 닫기는 있다', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    await mount();
    await select('수치 있는 스프린트');
    expect(container.querySelector(`button[aria-label="${S.delete}"]`)).toBeNull();
    expect(container.querySelector(`button[aria-label="${S.cancel}"]`)).not.toBeNull();
  });

  it('⭐계획 수치(용량 SP · 인원 · 기간)가 ds 칩이고 값이 그대로다 — 손으로 만든 rounded-md border 칸이 아니다', async () => {
    await mount();
    await select('수치 있는 스프린트');
    const chips = [...detail()!.querySelectorAll('[data-slot="ds-chip"]')].map((c) => c.textContent ?? '');
    expect(chips.some((c) => c.includes('20') && c.includes('SP'))).toBe(true);
    expect(chips.some((c) => c.includes('3') && c.includes(S.personCountUnit))).toBe(true);
    expect(chips.some((c) => c.includes(`14${S.days}`))).toBe(true);
    expect(detail()!.querySelectorAll('span.bg-muted\\/30')).toHaveLength(0);
  });

  it('용량 · 인원이 둘 다 없으면 수치 칸 자체가 없다(예전과 같은 조건)', async () => {
    await mount();
    await select('수치 없는 스프린트');
    expect(detail()!.querySelectorAll('[data-slot="ds-chip"]')).toHaveLength(0);
  });

  it('⭐목록 줄의 «리포트 보기» 링크가 폰 누름 영역 44를 가진다(text-xs 한 줄이던 것)', async () => {
    await mount();
    const link = rowOf('수치 있는 스프린트').querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    const cls = link.className.split(/\s+/);
    expect(cls).toContain('touch:min-h-11');
    expect(cls).toContain('touch:inline-flex');
  });
});
