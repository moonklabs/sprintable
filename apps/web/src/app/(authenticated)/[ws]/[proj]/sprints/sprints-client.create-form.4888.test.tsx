// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면 본체 마무리) — 스프린트 만들기 폼 + 열기 단추 + 삭제 확인창을 ds로: 이름 · 목표 · 용량 · 인원 칸(이름이 칸에 안 이어지던 label + 옛 Input)을 ds Field + ds Input으로,
// 계획 블록(손 카드 rounded-xl border bg-muted/20)을 ds Card로, 닫기(raw button)를 ds IconButton으로, 아래 단추 · 삭제 확인 단추 · 열기 단추 · 빈 화면 CTA를 ds Button으로.
// 새 기능 0 · 값 · 초안 · 전송 모양은 그대로(기존 만들기 시험이 그걸 지킨다).
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
const S = koMessages.sprints;
const TC = koMessages.common;
const SPRINT = { id: 's1', title: '계획 스프린트', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' };
let sprintList: unknown[];
let calls: Array<{ url: string; method?: string }>;

beforeEach(() => {
  sprintList = [SPRINT];
  calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    calls.push({ url, method: init?.method });
    if (init?.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) };
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: sprintList }) };
    if (url.includes('/hypotheses')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.resetModules(); });

async function mount() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SprintsClient projectId="proj-1" orgId="org-1" /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const dialog = () => document.body.querySelector('[role="dialog"], [role="alertdialog"]') as HTMLElement;
const byText = (scope: ParentNode, label: string) => [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined;
const cls = (e: Element) => e.className.split(/\s+/);
async function openCreate() {
  await mount();
  const opener = container.querySelector('[data-testid="top-bar"] button') as HTMLButtonElement;
  await act(async () => { opener.click(); });
  await flush();
}

describe('스프린트 만들기 폼 · 열기 단추 · 삭제 확인 — ds 부품(story #4888)', () => {
  it('⭐상단 «새 스프린트» 열기 단추가 ds Button(primary)이고 이름이 있다', async () => {
    await mount();
    const opener = container.querySelector('[data-testid="top-bar"] button') as HTMLButtonElement;
    expect(opener.getAttribute('data-slot')).toBe('ds-button');
    expect(opener.getAttribute('aria-label')).toBe(S.newSprint);
    expect(cls(opener)).toContain('bg-ds-action');
    expect(cls(opener)).toContain('touch:min-h-11');
  });

  it('⭐빈 화면 «첫 스프린트 시작하기» CTA가 ds Button(primary)이고 누르면 폼이 열린다', async () => {
    sprintList = [];
    await mount();
    const cta = byText(container, S.noSprintsCta)!;
    expect(cta.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(cta)).toContain('bg-ds-action');
    await act(async () => { cta.click(); });
    await flush();
    expect(dialog()).toBeTruthy();
  });

  it('⭐이름 · 목표 · 용량 · 인원 칸이 ds Input이고 이름(label)이 칸에 이어져 있다 — 폰 44', async () => {
    await openCreate();
    const d = dialog();
    const inputs = [...d.querySelectorAll('input')].filter((i) => i.type === 'text' || i.type === 'number') as HTMLInputElement[];
    expect(inputs).toHaveLength(4);
    for (const i of inputs) {
      expect(i.getAttribute('data-slot')).toBe('ds-input');
      expect(cls(i)).toContain('touch:h-11');
      expect(i.labels?.[0]?.textContent, i.placeholder).toBeTruthy();   // 예전엔 label이 칸에 안 이어져 이름이 없었다
    }
    const names = inputs.map((i) => i.labels![0]!.textContent ?? '');
    expect(names.some((n) => n.includes(S.sprintTitle))).toBe(true);
    expect(names.some((n) => n.includes(S.goalLabel))).toBe(true);
    expect(names.some((n) => n.includes(S.capacityLabel))).toBe(true);
    expect(names.some((n) => n.includes(S.teamSizeLabel))).toBe(true);
  });

  it('⭐계획 블록이 ds Card이고 손 카드(rounded-xl border bg-muted/20)가 아니다', async () => {
    await openCreate();
    const d = dialog();
    const card = [...d.querySelectorAll('[data-slot="ds-card"]')].find((c) => (c.textContent ?? '').includes(S.planSection));
    expect(card).toBeTruthy();
    expect(d.querySelectorAll('.bg-muted\\/20')).toHaveLength(0);
  });

  it('⭐닫기가 이름 있는 ds 아이콘 단추이고 누르면 폼이 닫힌다', async () => {
    await openCreate();
    const x = dialog().querySelector(`button[aria-label="${TC.close}"]`) as HTMLButtonElement;
    expect(x.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(cls(x)).toContain('touch:min-h-11');
    await act(async () => { x.click(); });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('⭐아래 단추: 취소 = quiet · 임시저장 = secondary · 시작 = primary, 모두 ds Button', async () => {
    await openCreate();
    const d = dialog();
    const cancel = byText(d, S.cancel)!, draft = byText(d, S.saveDraft)!, start = byText(d, S.activate)!;
    for (const b of [cancel, draft, start]) expect(b.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(start)).toContain('bg-ds-action');
    expect(cls(draft)).not.toContain('bg-ds-action');
    expect(cls(cancel)).not.toContain('bg-ds-action');
    expect(cls(cancel)).toContain('bg-transparent');
  });

  it('⭐삭제 확인창: 취소 = quiet · 삭제 = danger(ds Button), «삭제»를 누르면 DELETE 한 번', async () => {
    await mount();
    const li = [...container.querySelectorAll('li')].find((x) => x.textContent?.includes('계획 스프린트'))!;
    await act(async () => { li.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await act(async () => { (container.querySelector(`button[aria-label="${S.delete}"]`) as HTMLButtonElement).click(); });
    await flush();
    const d = dialog();
    expect(d.getAttribute('role')).toBe('alertdialog');
    const cancel = byText(d, S.cancel)!, del = byText(d, S.deleteConfirm)!;
    expect(cancel.getAttribute('data-slot')).toBe('ds-button');
    expect(del.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(del)).toContain('text-ds-failed');   // danger
    await act(async () => { del.click(); });
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([{ url: '/api/sprints/s1', method: 'DELETE' }]);
  });
});
