// @vitest-environment jsdom
//
// story 4831 부품 교체(문서·목표 묶음 — 목표) — 목표 상세의 인라인 편집 폼(EpicEditInline)의 날것 일곱(제목 · 설명 · 목표 · 성공 기준 · 우선순위 · 목표일 · 목표 포인트)이
// 바탕 Input · Textarea · Select가 되어도 동작이 그대로여야 한다: 값을 고치면 저장 요청(PATCH 본문)에 그대로 실린다. 되돌리면(날것으로) data-slot이 사라져 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

const { replaceMock, routerMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return { replaceMock, routerMock: { replace: replaceMock, push: vi.fn() } };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'epic-1' }), useRouter: () => routerMock }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));
vi.mock('@/components/dispatch/entity-dispatch-panel', () => ({ EntityDispatchPanel: () => <div /> }));
vi.mock('@/components/hypotheses/hypotheses-section', () => ({ HypothesesSection: () => <div /> }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgSyncPending: false }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); replaceMock.mockReset(); });

const goals = koMessages.goals as unknown as Record<string, string>;
const epic = {
  id: 'epic-1', title: '목표 제목', description: '설명', objective: '성과', success_criteria: '기준', status: 'active', priority: 'medium',
  project_id: 'proj-1', assignee_id: null, target_sp: 8, target_date: '2026-12-31T00:00:00Z',
  stories: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

const patches: Array<Record<string, unknown>> = [];
async function mount() {
  patches.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      patches.push(body);
      return { ok: true, status: 200, json: async () => ({ data: { ...epic, ...body } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: epic }) };
  }));
  const { default: EpicDetailPage } = await import('./page');
  const { GoalsRouteProvider } = await import('../goals-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <GoalsRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1" orgId="org-1"><EpicDetailPage /></GoalsRouteProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('목표 상세 인라인 편집 폼 — 바탕 Input · Textarea · Select (story 4831 부품 교체)', () => {
  it('편집을 열면 일곱 칸이 모두 바탕 부품이고 기존 값이 채워져 있다', async () => {
    await mount();
    await act(async () => { button(goals.edit).click(); });
    const title = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${goals.fieldTitlePlaceholder}"]`)!;
    expect(title.value).toBe('목표 제목');
    const areas = [...container.querySelectorAll<HTMLTextAreaElement>('textarea[data-slot="textarea"]')];
    expect(areas.map((a) => a.value)).toEqual(['설명', '성과', '기준']);
    expect(container.querySelector<HTMLSelectElement>('select[data-slot="select"]')!.value).toBe('medium');
    expect(container.querySelector<HTMLInputElement>('input[type="date"][data-slot="input"]')!.value).toBe('2026-12-31');
    expect(container.querySelector<HTMLInputElement>('input[type="number"][data-slot="input"]')!.value).toBe('8');
  });

  it('값을 고치고 저장하면 PATCH 본문에 고친 값이 그대로 실린다(네이티브 change · input 이벤트)', async () => {
    await mount();
    await act(async () => { button(goals.edit).click(); });
    const title = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${goals.fieldTitlePlaceholder}"]`)!;
    await act(async () => { setNative(title, '새 제목'); });
    const select = container.querySelector<HTMLSelectElement>('select[data-slot="select"]')!;
    await act(async () => { select.value = 'critical'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const areas = [...container.querySelectorAll<HTMLTextAreaElement>('textarea[data-slot="textarea"]')];
    await act(async () => { setNative(areas[1]!, '새 성과'); });
    const date = container.querySelector<HTMLInputElement>('input[type="date"][data-slot="input"]')!;
    await act(async () => { setNative(date, '2027-01-15'); });
    const sp = container.querySelector<HTMLInputElement>('input[type="number"][data-slot="input"]')!;
    await act(async () => { setNative(sp, '13'); });
    await act(async () => { button(goals.saveChanges).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ title: '새 제목', priority: 'critical', objective: '새 성과', target_date: '2027-01-15', target_sp: 13 });
  });

  it('제목을 비우면 저장 단추가 잠겨 요청이 가지 않는다', async () => {
    await mount();
    await act(async () => { button(goals.edit).click(); });
    const title = container.querySelector<HTMLInputElement>(`input[data-slot="input"][placeholder="${goals.fieldTitlePlaceholder}"]`)!;
    await act(async () => { setNative(title, '   '); });
    expect(button(goals.saveChanges).disabled).toBe(true);
    expect(patches).toHaveLength(0);
  });
});
