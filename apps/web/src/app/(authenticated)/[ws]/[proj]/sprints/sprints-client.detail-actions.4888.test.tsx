// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면 본체 셋째 조각) — 스프린트 상세 패널의 행동 단추(시작 · 취소 · 종료): 옛 ui/button size=sm(높이 28, 폰 누름 영역 44 미만)을 ds Button으로.
// 주 행동(스프린트 시작) = primary, 보조(취소 · 종료) = secondary. 진행 중(«...» + 비활성) · 확인창 · 오류 표시 · 요청 모양은 그대로.
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
const { useDashboardContextMock, fetchWithAuthMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), fetchWithAuthMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const PLANNING = { id: 's1', title: '계획 스프린트', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' };
const ACTIVE = { id: 's2', title: '진행 스프린트', status: 'active', start_date: '2026-08-01', end_date: '2026-08-14' };
const S = koMessages.sprints;
let posts: string[];
let activateImpl: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

beforeEach(() => {
  posts = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  activateImpl = async () => ({ ok: true, json: async () => ({ data: {} }) });
  fetchWithAuthMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      posts.push(`${init.method} ${url}`);
      if (url.endsWith('/activate')) return activateImpl();
      return { ok: true, json: async () => ({ data: {} }) };
    }
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [PLANNING, ACTIVE] }) };
    if (url.includes('/hypotheses')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/burndown')) return { ok: false, json: async () => null };
    if (url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [PLANNING, ACTIVE] }) };
    if (typeof url === 'string' && url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

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
const btn = (label: string) => [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined;
const cls = (b: HTMLElement) => b.className.split(/\s+/);

describe('스프린트 상세 패널 행동 단추 — ds Button(story #4888)', () => {
  it('⭐계획 중 스프린트: «스프린트 시작»은 primary, «스프린트 취소»는 secondary, 둘 다 ds Button · 폭 가득 · 폰 44', async () => {
    await mount();
    await select('계획 스프린트');
    const start = btn(S.activate)!;
    const cancel = btn(S.cancelSprint)!;
    expect(start).toBeTruthy(); expect(cancel).toBeTruthy();
    for (const b of [start, cancel]) {
      expect(b.getAttribute('data-slot')).toBe('ds-button');
      expect(cls(b)).toContain('w-full');
      expect(cls(b)).toContain('pointer-coarse:min-h-11');
    }
    expect(cls(start)).toContain('bg-ds-action');          // primary
    expect(cls(cancel)).not.toContain('bg-ds-action');     // secondary
  });

  it('⭐진행 중 스프린트: «스프린트 종료»가 ds Button(secondary) · 폭 가득 · 폰 44', async () => {
    await mount();
    await select('진행 스프린트');
    const close = btn(S.close)!;
    expect(close).toBeTruthy();
    expect(close.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(close)).toContain('w-full');
    expect(cls(close)).toContain('pointer-coarse:min-h-11');
    expect(cls(close)).not.toContain('bg-ds-action');
    expect(btn(S.activate)).toBeUndefined();
  });

  it('⭐«스프린트 시작»을 누르면 POST /activate 한 번, 진행 중에는 «...»로 바뀌고 눌러도 두 번 안 나간다', async () => {
    let release!: () => void;
    activateImpl = () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ data: {} }) }); });
    await mount();
    await select('계획 스프린트');
    await act(async () => { btn(S.activate)!.click(); });
    expect(posts).toEqual(['POST /api/sprints/s1/activate']);
    const busy = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '...') as HTMLButtonElement;
    expect(busy).toBeTruthy();
    expect(busy.disabled).toBe(true);
    await act(async () => { busy.click(); });
    expect(posts).toHaveLength(1);
    await act(async () => { release(); });
    await flush();
  });

  it('⭐활성화가 실패하면 오류 문구가 role=alert로 나온다(조용한 실패 없음)', async () => {
    activateImpl = async () => ({ ok: false, json: async () => ({}) });
    await mount();
    await select('계획 스프린트');
    await act(async () => { btn(S.activate)!.click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(S.activateError);
  });

  it('⭐«스프린트 취소» · «스프린트 종료»는 확인창이 «아니오»면 아무것도 안 보낸다, «예»면 POST /close', async () => {
    const confirmMock = vi.spyOn(window, 'confirm');
    await mount();
    await select('계획 스프린트');
    confirmMock.mockReturnValue(false);
    await act(async () => { btn(S.cancelSprint)!.click(); });
    await flush();
    expect(confirmMock).toHaveBeenCalledWith(S.cancelConfirm);
    expect(posts).toHaveLength(0);
    confirmMock.mockReturnValue(true);
    await act(async () => { btn(S.cancelSprint)!.click(); });
    await flush();
    expect(posts).toEqual(['POST /api/sprints/s1/close']);
  });

  it('진행 중 스프린트 종료는 종료 확인 문구로 묻고 POST /close', async () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount();
    await select('진행 스프린트');
    await act(async () => { btn(S.close)!.click(); });
    await flush();
    expect(confirmMock).toHaveBeenCalledWith(S.closeConfirm);
    expect(posts).toEqual(['POST /api/sprints/s2/close']);
  });
});
