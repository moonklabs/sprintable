// @vitest-environment jsdom
//
// story 4892 (UI-9 활동) — the activity screen's filter row, empty / error states and loading placeholders wear ds parts, behaviour unchanged: the filter dropdowns are ds NativeSelects named by their label (the old
// custom dropdown named itself by its placeholder), the text / date fields are ds Inputs, the empty · forbidden · error states are ds EmptyStates, the loading placeholders are ds SkeletonGroups (one «불러오는 중» for the
// group, bars decorative). The old ui/ empty-state · operator-dropdown-select · page-skeleton are gone from both views and the route's loading file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ActivityLogView } from './activity-log-view';
import { TeamActivityView } from './team-activity-view';
import { ActivityLoadingSkeleton } from './activity-loading-skeleton';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';
import auditSource from './activity-log-view.tsx?raw';
import teamSource from './team-activity-view.tsx?raw';
import loadingRouteSource from '../../app/(authenticated)/activity/loading.tsx?raw';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args) }));
const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));
import { resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ko = koMessages as unknown as Record<string, Record<string, string>>;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  addToastMock.mockClear();
  resetOrgMembersCacheForTests();
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (ok: boolean, status: number, data?: unknown): Answer => ({ ok, status, json: async () => ({ data }) });
const auditRow = (id: string) => ({ id, actor_id: 'm1', actor_name: '안나', actor_type: 'human', action: 'story.updated', entity_type: 'story', entity_title: `일감 ${id}`, context: null, created_at: new Date().toISOString() });
const teamItem = (seq: number) => ({ activity_id: `a${seq}`, project_id: 'p1', actor_id: null, verb: 'updated', object_type: 'doc', object_id: `d${seq}`, occurred_at: new Date().toISOString(), source_event_ids: [], recipient_ids: [], recipient_types: [], payload: {}, activity_seq: seq });
function api(audit: () => Answer | Promise<Answer>, team: () => Answer | Promise<Answer>) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return answer(true, 200, [{ id: 'm1', name: '안나', type: 'human' }]);
    if (url.includes('/api/activity-logs')) return audit();
    if (url.includes('/api/activity-stream')) return team();
    return answer(false, 404);
  });
}
const auditOk = (items: unknown[]) => () => answer(true, 200, { items, total: items.length, limit: 30, offset: 0 });
const teamOk = (items: unknown[]) => () => answer(true, 200, { items, next_after_seq: null, next_before_seq: null });
async function mountView(which: 'audit' | 'team') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <TopBarProvider>{which === 'audit' ? <ActivityLogView projectId="p1" /> : <TeamActivityView projectId="p1" />}</TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
const selects = () => [...container.querySelectorAll('[data-slot="ds-select"] select')] as HTMLSelectElement[];
const change = async (el: HTMLSelectElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
};
const urlsOf = (part: string) => fetchWithAuthMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(part));

describe('감사 로그 필터 줄 — ds 부품 (4892)', () => {
  it('⭐수행자 · 엔티티 유형은 ds NativeSelect(이름 = 보이는 라벨), 고르면 같은 요청 파라미터로 다시 불러온다', async () => {
    api(auditOk([auditRow('a1')]), teamOk([]));
    await mountView('audit');
    expect(selects().map((s) => s.getAttribute('aria-label'))).toEqual([ko.activityLog!.filterActor, ko.activityLog!.filterEntityType]);
    expect(selects()[1]!.querySelector('option[value="story"]')).not.toBeNull();
    await change(selects()[1]!, 'story');
    expect(urlsOf('/api/activity-logs').some((u) => u.includes('entity_type=story'))).toBe(true);
    await change(selects()[0]!, 'm1');
    expect(urlsOf('/api/activity-logs').some((u) => u.includes('actor_id=m1'))).toBe(true);
  });

  it('⭐액션 칸은 ds Input(이름 · 200자 상한), 입력은 300ms 뒤 action 파라미터로 간다 · 날짜 칸 둘은 ds Input(이름 유지)', async () => {
    api(auditOk([auditRow('a1')]), teamOk([]));
    await mountView('audit');
    const action = container.querySelector(`input[aria-label="${ko.activityLog!.filterAction}"]`) as HTMLInputElement;
    expect(action.getAttribute('data-slot')).toBe('ds-input');
    expect(action.getAttribute('maxlength')).toBe('200');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(action, 'doc.deleted');
      action.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(urlsOf('/api/activity-logs').some((u) => u.includes('action=doc.deleted'))).toBe(false);   // not before the debounce
    await act(async () => { vi.advanceTimersByTime(350); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(urlsOf('/api/activity-logs').some((u) => u.includes('action=doc.deleted'))).toBe(true);
    for (const label of [ko.activityLog!.fromDate, ko.activityLog!.toDate]) {
      const d = container.querySelector(`input[type="date"][aria-label="${label}"]`) as HTMLInputElement;
      expect(d.getAttribute('data-slot')).toBe('ds-input');
    }
  });

  it('⭐비었다 · 접근 불가 · 오류는 ds EmptyState(오류에는 ds «다시 시도»)', async () => {
    api(auditOk([]), teamOk([]));
    await mountView('audit');
    let es = container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
    expect(es.textContent).toContain(ko.activityLog!.emptyTitle);
    expect(es.querySelector('button[data-slot="ds-button"]')).not.toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    api(() => answer(false, 403), teamOk([]));
    await mountView('audit');
    es = container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
    expect(es.textContent).toContain(ko.activityLog!.forbiddenTitle);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    api(() => answer(false, 500), teamOk([]));
    await mountView('audit');
    es = container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
    expect(es.textContent).toContain(ko.common!.error);
    expect(es.textContent).not.toContain(ko.activityLog!.emptyTitle);                 // ⭐a refused first page is NOT «활동 내역이 없어요» (it was, before 4892)
    expect([...es.querySelectorAll('button[data-slot="ds-button"]')].some((b) => b.textContent?.trim() === ko.common!.retry)).toBe(true);
  });

  it('⭐«다시 시도»가 또 거절당하면 빈 목록이 아니라 오류 상태 그대로(다시 불러오기도 같은 규칙)', async () => {
    api(() => answer(false, 500), teamOk([]));
    await mountView('audit');
    const retry = () => [...container.querySelectorAll('[data-slot="ds-empty-state"] button')].find((b) => b.textContent?.trim() === ko.common!.retry) as HTMLButtonElement;
    await act(async () => { retry().click(); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    const es = container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
    expect(es.textContent).toContain(ko.common!.error);
    expect(es.textContent).not.toContain(ko.activityLog!.emptyTitle);
    expect(urlsOf('/api/activity-logs').length).toBe(2);   // it asked again
  });

  it('⭐다시 시도가 오는 중에 필터를 바꿔 새 요청이 잘 오면, 늦게 도착한 옛 요청의 500은 오류 상태를 덮어쓰지 못한다', async () => {
    let calls = 0;
    let releaseStale: (a: Answer) => void = () => {};
    api(() => {
      calls += 1;
      if (calls === 1) return answer(false, 500);                                                  // first page refused → error state
      if (calls === 2) return new Promise<Answer>((resolve) => { releaseStale = resolve; });       // «다시 시도» — held in flight
      return answer(true, 200, { items: [auditRow('fresh')], total: 1, limit: 30, offset: 0 });     // the filtered request answers fine
    }, teamOk([]));
    await mountView('audit');
    const retry = [...container.querySelectorAll('[data-slot="ds-empty-state"] button')].find((b) => b.textContent?.trim() === ko.common!.retry) as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await change(selects()[1]!, 'story');                                                           // a filter change while the retry is still in flight
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();                        // the newer answer is on screen
    await act(async () => { releaseStale(answer(false, 500)); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();                      // the stale 500 did not put the error back
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();
  });

  it('⭐다시 시도가 오는 중에 필터를 바꿔 새 요청이 잘 오면, 늦게 도착한 옛 요청의 403도 «접근 불가»로 덮어쓰지 못한다', async () => {
    let calls = 0;
    let releaseStale: (a: Answer) => void = () => {};
    api(() => {
      calls += 1;
      if (calls === 1) return answer(false, 500);
      if (calls === 2) return new Promise<Answer>((resolve) => { releaseStale = resolve; });
      return answer(true, 200, { items: [auditRow('fresh')], total: 1, limit: 30, offset: 0 });
    }, teamOk([]));
    await mountView('audit');
    const retry = [...container.querySelectorAll('[data-slot="ds-empty-state"] button')].find((b) => b.textContent?.trim() === ko.common!.retry) as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await change(selects()[1]!, 'story');
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();
    await act(async () => { releaseStale(answer(false, 403)); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();                      // the stale 403 did not turn the list into «접근 불가»
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();
  });

  it('⭐필터를 연달아 바꿔 앞 요청이 403으로 늦게 오면, 뒤 요청의 목록을 «접근 불가»로 덮어쓰지 못한다', async () => {
    let calls = 0;
    let releaseStale: (a: Answer) => void = () => {};
    api(() => {
      calls += 1;
      if (calls === 1) return answer(true, 200, { items: [auditRow('first')], total: 1, limit: 30, offset: 0 });
      if (calls === 2) return new Promise<Answer>((resolve) => { releaseStale = resolve; });           // filter change #1 — held in flight
      return answer(true, 200, { items: [auditRow('latest')], total: 1, limit: 30, offset: 0 });       // filter change #2 answers fine
    }, teamOk([]));
    await mountView('audit');
    const options = [...selects()[1]!.options].map((o) => o.value).filter((v) => v !== selects()[1]!.options[0]!.value);
    await change(selects()[1]!, options[0]!);
    await change(selects()[1]!, options[1]!);
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();
    await act(async () => { releaseStale(answer(false, 403)); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();
  });

  describe('«더 보기»가 오는 중에 필터를 바꾸면 (옛 목록의 답은 낡은 답)', () => {
    const page = (n: number, tag: string, total: number) => answer(true, 200, { items: Array.from({ length: n }, (_, i) => auditRow(`${tag}${i}`)), total, limit: 30, offset: 0 });
    const loadMoreButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === ko.activityLog!.loadMore) as HTMLButtonElement | undefined;
    const rows = () => container.querySelectorAll('button[data-audit-row]').length;
    async function startStaleLoadMore(): Promise<{ release: (a: Answer) => void; fail: (e: Error) => void }> {
      let calls = 0;
      let release: (a: Answer) => void = () => {};
      let fail: (e: Error) => void = () => {};
      api(() => {
        calls += 1;
        if (calls === 1) return page(30, 'old', 90);                                                  // first page of the unfiltered list: 30 of 90
        if (calls === 2) return new Promise<Answer>((resolve, reject) => { release = resolve; fail = reject; });   // «더 보기» — held in flight
        return page(1, 'fresh', 1);                                                                    // the filtered list
      }, teamOk([]));
      await mountView('audit');
      expect(rows()).toBe(30);
      await act(async () => { loadMoreButton()!.click(); });
      await change(selects()[1]!, 'story');                                                           // filter change while «더 보기» is still in flight
      expect(rows()).toBe(1);
      return { release: (a) => release(a), fail: (e) => fail(e) };
    }

    it('⭐늦게 온 옛 «더 보기» 성공은 새 목록에 줄을 붙이지 못한다(줄 수 · 합계 그대로)', async () => {
      const { release } = await startStaleLoadMore();
      await act(async () => { release(page(30, 'stale', 90)); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(rows()).toBe(1);
      expect(loadMoreButton()).toBeUndefined();                                                        // total 1 → no «더 보기»: the stale total 90 did not leak in
    });

    it('⭐늦게 온 옛 «더 보기» 실패는 토스트를 띄우지 못한다', async () => {
      const { release } = await startStaleLoadMore();
      await act(async () => { release(answer(false, 500)); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(addToastMock).not.toHaveBeenCalled();
      expect(rows()).toBe(1);
    });

    it('⭐늦게 온 옛 «더 보기» 403은 새 목록을 «접근 불가»로 바꾸지 못한다', async () => {
      const { release } = await startStaleLoadMore();
      await act(async () => { release(answer(false, 403)); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();
      expect(rows()).toBe(1);
    });

    it('⭐늦게 온 옛 «더 보기» 네트워크 오류도 토스트를 띄우지 못한다', async () => {
      const { fail } = await startStaleLoadMore();
      await act(async () => { fail(new Error('offline')); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(addToastMock).not.toHaveBeenCalled();
      expect(rows()).toBe(1);
    });

    it('⭐새 목록의 «더 보기»가 오는 중에 옛 «더 보기»가 늦게 끝나도 새 쪽 돌림 표시는 그대로', async () => {
      let calls = 0;
      let releaseStale: (a: Answer) => void = () => {};
      api(() => {
        calls += 1;
        if (calls === 1) return page(30, 'old', 90);
        if (calls === 2) return new Promise<Answer>((resolve) => { releaseStale = resolve; });         // the old list's «더 보기» (stale from the filter change on)
        if (calls === 3) return page(30, 'fresh', 90);                                                  // the filtered list, also 30 of 90
        return new Promise<Answer>(() => {});                                                           // the new list's own «더 보기» — never answers
      }, teamOk([]));
      await mountView('audit');
      await act(async () => { loadMoreButton()!.click(); });
      await change(selects()[1]!, 'story');
      await act(async () => { loadMoreButton()!.click(); });
      expect(loadMoreButton()!.getAttribute('aria-busy')).toBe('true');
      await act(async () => { releaseStale(page(30, 'stale', 90)); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(loadMoreButton()!.getAttribute('aria-busy')).toBe('true');                                 // the stale finish did not clear the newer spinner
      expect(rows()).toBe(30);
    });

    it('⭐화면을 떠난 뒤 늦게 온 «더 보기» 실패는 토스트를 띄우지 못한다', async () => {
      let calls = 0;
      let fail: (e: Error) => void = () => {};
      api(() => {
        calls += 1;
        if (calls === 1) return page(30, 'old', 90);
        return new Promise<Answer>((_resolve, reject) => { fail = reject; });                          // «더 보기» — held in flight, the filter never changes
      }, teamOk([]));
      await mountView('audit');
      await act(async () => { loadMoreButton()!.click(); });
      await act(async () => { root.unmount(); });
      root = createRoot(container);                                                                    // the afterEach unmounts a root too
      await act(async () => { fail(new Error('offline')); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(addToastMock).not.toHaveBeenCalled();
    });

    it('«더 보기» 성공 · 같은 목록이면 그대로 붙는다(막은 것은 낡은 답뿐)', async () => {
      let calls = 0;
      api(() => { calls += 1; return calls === 1 ? page(30, 'old', 60) : page(30, 'more', 60); }, teamOk([]));
      await mountView('audit');
      await act(async () => { loadMoreButton()!.click(); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
      expect(rows()).toBe(60);
    });
  });

  it('⭐«다시 시도»는 다시 묻고, 이번엔 잘 오면 목록이 선다 · «더 보기» 실패는 지금처럼 토스트(오류 상태 아님)', async () => {
    let calls = 0;
    api(() => (++calls === 1 ? answer(false, 502) : answer(true, 200, { items: [auditRow('ok1')], total: 1, limit: 30, offset: 0 })), teamOk([]));
    await mountView('audit');
    const retry = [...container.querySelectorAll('[data-slot="ds-empty-state"] button')].find((b) => b.textContent?.trim() === ko.common!.retry) as HTMLButtonElement;
    await act(async () => { retry.click(); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();
    expect(container.querySelector('button[data-audit-row]')).not.toBeNull();
  });

  it('⭐불러오는 동안은 ds SkeletonGroup(role=status · 이름 «불러오는 중» 한 번) + 장식 막대 8줄', async () => {
    api(() => new Promise<Answer>(() => {}), teamOk([]));
    await mountView('audit');
    const group = container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
    expect(group.getAttribute('role')).toBe('status');
    expect(group.getAttribute('aria-label')).toBe(ko.common!.loading);
    const bars = [...group.querySelectorAll('[data-slot="ds-skeleton"]')];
    expect(bars.length).toBe(8);
    expect(bars.every((b) => b.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});

describe('팀 활동 필터 줄 — ds 부품 (4892)', () => {
  it('⭐행위자 · 대상 · 동작은 ds NativeSelect(이름 = 보이는 라벨), 대상을 고르면 object_type 파라미터가 간다', async () => {
    api(auditOk([]), teamOk([teamItem(1)]));
    await mountView('team');
    expect(selects().map((s) => s.getAttribute('aria-label'))).toEqual([ko.teamActivity!.filterActor, ko.teamActivity!.filterObject, ko.teamActivity!.filterVerb]);
    const opts = [...selects()[1]!.querySelectorAll('option')].map((o) => o.value);
    expect(opts.length).toBeGreaterThan(1);
    await change(selects()[1]!, opts[1]!);
    expect(urlsOf('/api/activity-stream').some((u) => u.includes(`object_type=${opts[1]}`))).toBe(true);
    for (const label of [ko.teamActivity!.fromDate, ko.teamActivity!.toDate]) {
      expect(container.querySelector(`input[type="date"][aria-label="${label}"]`)!.getAttribute('data-slot')).toBe('ds-input');
    }
  });

  it('⭐비었다 · 접근 불가는 ds EmptyState(비었다는 ds 받은편지 아이콘) · 불러오는 동안은 ds SkeletonGroup + 줄마다 동그라미 · 막대', async () => {
    api(auditOk([]), teamOk([]));
    await mountView('team');
    let es = container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
    expect(es.textContent).toContain(ko.teamActivity!.emptyTitle);
    expect(es.querySelector('[data-icon="inbox"]')).not.toBeNull();
    await act(async () => { root.unmount(); }); root = createRoot(container);
    api(auditOk([]), () => answer(false, 403));
    await mountView('team');
    es = container.querySelector('[data-slot="ds-empty-state"]') as HTMLElement;
    expect(es.textContent).toContain(ko.teamActivity!.forbiddenTitle);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    api(auditOk([]), () => new Promise<Answer>(() => {}));
    await mountView('team');
    const group = container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe(ko.common!.loading);
    expect(group.querySelectorAll('[data-variant="circle"]').length).toBe(3);
    expect(group.querySelectorAll('[data-slot="ds-skeleton"]').length).toBe(9);   // 3 rows × (circle + 2 bars)
  });
});

describe('활동 로딩 경로 — ds 스켈레톤 (4892)', () => {
  it('⭐ActivityLoadingSkeleton: 한 묶음(이름 «불러오는 중») · 제목 막대 + 설명 막대 + 줄 다섯', async () => {
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC"><ActivityLoadingSkeleton /></NextIntlClientProvider>); });
    const group = container.querySelector('[data-slot="ds-skeleton-group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe(ko.common!.loading);
    expect(group.querySelectorAll('[data-slot="ds-skeleton"]').length).toBe(2 + 5);
  });

  it('두 화면과 로딩 경로에 옛 ui/ 빈 상태 · 드롭다운 · 페이지 스켈레톤 · 날 입력칸이 없다', () => {
    for (const src of [auditSource, teamSource]) {
      expect(src).not.toMatch(/from '@\/components\/ui\/(empty-state|operator-dropdown-select|page-skeleton)'/);
      expect(src).not.toMatch(/<input\b/);
      expect(src).not.toMatch(/OperatorDropdownSelect/);
    }
    expect(loadingRouteSource).not.toMatch(/page-skeleton|PageSkeleton/);
    expect(loadingRouteSource).toMatch(/<ActivityLoadingSkeleton\s*\/>/);   // rendered, not just imported
  });
});
