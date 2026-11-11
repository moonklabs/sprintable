// @vitest-environment jsdom
//
// story #4888 (UI-5, the goals screen · AC3 §4-2) — the goals screen as ONE composition: one head (title + counts + view switch + state filter), a list of ds rows
// (title · state / priority chips · progress «done/total» · result state), and — on a wide screen — a detail column beside it (facts · progress · result · hypotheses · story list · edit).
// A phone keeps its old way: a row opens the goal's own page. Every test here goes RED if the thing it names is put back the old way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

const { pushMock, hypothesesMock } = vi.hoisted(() => ({ pushMock: vi.fn(), hypothesesMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('./goals-context', () => ({ useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }) }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
// the hypotheses block is its own, shared screen part (the goal page uses it too) — here only «is it mounted for this goal» matters
vi.mock('@/components/hypotheses/hypotheses-section', () => ({
  HypothesesSection: (props: { epicId: string; projectId: string }) => {
    hypothesesMock(props);
    return <div data-testid="hypotheses-stub" data-epic={props.epicId} />;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const G1 = { id: 'g1', title: '첫 고객 10명', status: 'active', priority: 'medium', created_at: '2026-11-01T00:00:00Z', total_stories: 6, done_stories: 1, outcome_status: 'pending', measure_after: '2026-11-24T09:00:00Z', target_date: '2026-11-24T09:00:00Z', target_sp: 20, description: '첫 열 명의 고객을 만난다', hypothesis_count: 0, position: null, latest_story_activity_at: new Date().toISOString() };
const G2 = { id: 'g2', title: '런칭 주간 준비', status: 'active', priority: 'high', created_at: '2026-11-02T00:00:00Z', total_stories: 41, done_stories: 13, outcome_status: 'hit', position: null, latest_story_activity_at: new Date().toISOString() };
const G3 = { id: 'g3', title: '지난 분기 정리', status: 'done', priority: 'low', created_at: '2026-10-01T00:00:00Z', total_stories: 4, done_stories: 4, outcome_status: 'miss', position: null };
const G4 = { id: 'g4', title: '결과 판정 없이 닫힌 것', status: 'done', priority: 'critical', created_at: '2026-09-01T00:00:00Z', total_stories: 0, done_stories: 0, outcome_status: 'unmeasured', position: null };
const GOALS = [G1, G2, G3, G4];

const STORIES = {
  g1: [{ id: 's1', title: '인터뷰 질문지', status: 'done', story_points: 3 }, { id: 's2', title: '모집 글', status: 'in-progress', story_points: 5 }],
  g3: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, title: `정리 ${n}`, status: 'done' })),
};

function stubMedia(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide && /min-width:\s*1024px/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
}

function stubFetch(opts: { goals?: unknown[]; detail?: (id: string) => { ok: boolean; body?: unknown } } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/goals?')) return { ok: true, status: 200, json: async () => ({ data: opts.goals ?? GOALS }) };
    const m = typeof url === 'string' ? url.match(/\/api\/goals\/([^/?]+)$/) : null;
    if (m && (!init || !init.method || init.method === 'GET')) {
      const id = m[1]!;
      if (opts.detail) { const r = opts.detail(id); return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body ?? null }; }
      return { ok: true, status: 200, json: async () => ({ data: { id, project_id: 'proj-1', stories: (STORIES as Record<string, unknown[]>)[id] ?? [] } }) };
    }
    if (m && init?.method === 'PATCH') {
      // BE's edit answer carries no story counts (those ride on the list only)
      const { total_stories: _t, done_stories: _d, ...withoutCounts } = G1;
      return { ok: true, status: 200, json: async () => ({ data: { ...withoutCounts, title: '고친 제목' } }) };
    }
    return { ok: false, status: 404, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  pushMock.mockReset();
  hypothesesMock.mockReset();
  // Each test gets its OWN browser storage. The screen remembers the chosen view per project (`goals-view:<project>`): the «스윔레인» test leaves `swimlane` behind, and
  // wherever storage really persists inside one file (Node 22 jsdom · CI) the NEXT test would open the swimlane — head but no detail column (5623's CI red on the en test).
  // Where it does not persist (Node >= 25 here) the order dependence never showed. A fresh Map per test makes the result the same on both.
  const lsStore = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => { lsStore.set(k, v); },
    removeItem: (k: string) => { lsStore.delete(k); },
    clear: () => { lsStore.clear(); },
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(locale: 'ko' | 'en' = 'ko', props: Record<string, unknown> = {}) {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <GoalsClient projectId="proj-1" {...props} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const rows = () => qa('[data-testid="goal-row"]');
const rowOf = (id: string) => q(`[data-testid="goal-row"][data-row-key="${id}"]`)!;
const titleBtn = (id: string) => rowOf(id).querySelector<HTMLElement>('[data-row-focus]')!;
const detailId = () => q('[data-testid="goal-detail"]')?.getAttribute('data-goal-id') ?? null;
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); }); await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function key(el: Element, k: string) { await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); }

describe('목표 화면 — 한 장의 구성(머리 · 목록 행 · 상세 열)', () => {
  it('⭐머리는 한 덩이: h1 하나 + 활성 · 완료 수가 제목 옆에 · 옛 마스트헤드(kicker · 큰 제목 · 줄 · 한 줄 설명)는 없다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const head = q('[data-testid="goals-head"]')!;
    expect(head).not.toBeNull();
    expect(qa('h1').length).toBe(1);
    expect(head.querySelector('h1')!.textContent).toBe('목표');
    expect(head.textContent).toContain('활성 2'); // G1 · G2 (최근 움직임이 있는 active)
    expect(head.textContent).toContain('완료 2');
    expect(container.textContent).not.toContain('목표 · 결과');          // 옛 kicker
    expect(container.textContent).not.toContain('무엇이 증명되었는가');   // 옛 한 줄 설명
    expect(container.querySelector('.font-editorial-heading, hr.h-\\[3px\\]')).toBeNull();
  });

  it('⭐보기 전환과 상태 필터는 머리의 한 줄(controls)에 같이 선다 — 별도 줄이 아니다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const controls = q('[data-testid="goals-head-controls"]')!;
    expect(controls.contains(q('[data-testid="goals-view-switch"]'))).toBe(true);
    expect(controls.contains(q('[data-testid="goals-status-filter"]'))).toBe(true);
    // 폰에서는 줄바꿈 대신 옆으로 미는 한 줄 · 넓으면 줄바꿈
    expect(controls.className).toContain('flex-nowrap');
    expect(controls.className).toContain('overflow-x-auto');
    expect(controls.className).toContain('lg:flex-wrap');
    expect(controls.className).toContain('focus-inset');
  });

  it('⭐목표는 ds 목록 행이다 — 손으로 만든 카드(rounded-xl 박스 · 이중 진척바 · Badge · MaterialChip)가 없다', async () => {
    stubMedia(true); stubFetch(); await mount();
    expect(rows().length).toBe(4);
    for (const r of rows()) {
      expect(r.querySelector('[data-slot="ds-list-row"]')).not.toBeNull();
      expect(r.className).not.toContain('rounded-xl');
      expect(r.querySelector('.rounded-xl')).toBeNull();
      expect(r.querySelector('[data-slot="badge"]')).toBeNull();
    }
    expect(container.querySelector('[data-testid="goals-list"] .space-y-2')).toBeNull();
  });

  it('⭐행에 «완료/전체» 진척과 결과 상태가 있다 · 진척이 없는 목표는 «—»(0/0이 아님)', async () => {
    stubMedia(true); stubFetch(); await mount();
    const bar = (id: string) => rowOf(id).querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(rowOf('g1').textContent).toContain('1/6');
    expect(bar('g1').getAttribute('aria-valuenow')).toBe('1');
    expect(bar('g1').getAttribute('aria-valuemax')).toBe('6');
    expect(bar('g1').getAttribute('aria-label')).toBe('작업');
    expect(rowOf('g2').textContent).toContain('13/41');
    expect(rowOf('g4').textContent).not.toContain('0/0');
    expect(bar('g4').getAttribute('aria-valuenow')).toBeNull();
    expect(rowOf('g1').textContent).toContain('측정 예정');
    expect(rowOf('g2').textContent).toContain('적중');
  });

  it('⭐색 규율: 상태 칩은 초록이 아니다(done이어도) · 초록은 결과 «적중»뿐 · 진척 막대는 100%여도 «완료 초록»이 아니다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const chips = (id: string) => qa(`[data-testid="goal-row"][data-row-key="${id}"] [data-slot="ds-chip"]`);
    // 상태 칩 = 점이 있는 칩 — done 상태(G3)여도 done 톤이 아니다
    const statusChip = (id: string) => chips(id).find((c) => c.querySelector('[data-chip-dot]'))!;
    expect(statusChip('g3').getAttribute('data-tone')).not.toBe('done');
    expect(statusChip('g1').getAttribute('data-tone')).toBe('action');
    const toneOf = (id: string, text: string) => chips(id).find((c) => c.textContent === text)?.getAttribute('data-tone');
    expect(toneOf('g2', '적중')).toBe('done');
    expect(toneOf('g3', '빗나감')).toBe('neutral');
    expect(chips('g1').some((c) => c.textContent?.startsWith('측정 예정') && c.getAttribute('data-tone') === 'info')).toBe(true);
    // G3은 작업 4/4 = 100%인데 막대 채움이 «완료 초록»(data-complete → bg-ds-done)이 아니다
    const track = rowOf('g3').querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(track.getAttribute('aria-valuenow')).toBe('4');
    expect(rowOf('g3').querySelector('[data-slot="ds-progress-fill"]')!.className).not.toContain('bg-ds-done');
  });

  it('긴급 우선순위는 눈에 띄는 칩(failed 톤) · 나머지는 보통 칩', async () => {
    stubMedia(true); stubFetch(); await mount();
    const prio = (id: string, text: string) => qa(`[data-testid="goal-row"][data-row-key="${id}"] [data-slot="ds-chip"]`).find((c) => c.textContent === text)!;
    expect(prio('g4', '긴급').getAttribute('data-tone')).toBe('failed');
    expect(prio('g2', '높음').getAttribute('data-tone')).toBe('neutral');
  });
});

describe('목표 화면 — 넓은 화면: 상세 열', () => {
  it('⭐첫 목표가 고른 상태로 서고 상세 열에 그 목표가 보인다(빈 열이 없다)', async () => {
    stubMedia(true); stubFetch(); await mount();
    expect(q('[data-testid="goals-detail-column"]')).not.toBeNull();
    expect(detailId()).toBe('g1');
    expect(rowOf('g1').querySelector('[aria-current="true"]')).not.toBeNull();
    expect(rowOf('g2').querySelector('[aria-current]')).toBeNull();
    expect(q('[data-testid="goal-detail"] h2')!.textContent).toBe('첫 고객 10명');
  });

  it('⭐상세 열의 덩이: 일정 · 규모 / 진척(+결과) / 가설 / 설명 / 스토리 — 전부 ds Card이고 손으로 만든 박스가 없다', async () => {
    stubMedia(true); stubFetch(); await mount();
    for (const id of ['goal-detail-schedule', 'goal-detail-progress', 'goal-detail-description', 'goal-detail-stories']) {
      const el = q(`[data-testid="${id}"]`)!;
      expect(el, id).not.toBeNull();
      expect(el.getAttribute('data-slot'), id).toBe('ds-card');
    }
    expect(q('[data-testid="goal-detail-hypotheses"] [data-testid="hypotheses-stub"]')).not.toBeNull();
    const detail = q('[data-testid="goal-detail"]')!;
    expect(detail.querySelector('.rounded-xl')).toBeNull();
    expect(detail.querySelector('[data-slot="badge"]')).toBeNull();
    expect(detail.textContent).toContain('첫 열 명의 고객을 만난다'); // 설명
    expect(detail.textContent).toContain('20');                       // 목표 포인트
  });

  it('⭐상세에 «결과 상태»가 있다(카드 목록의 상세엔 없던 것) — 막대와 따로 한 줄', async () => {
    stubMedia(true); stubFetch(); await mount();
    const o = q('[data-testid="goal-detail-outcome"]')!;
    expect(o.textContent).toContain('결과');
    expect(o.textContent).toContain('측정 예정');
    await click(titleBtn('g2'));
    expect(q('[data-testid="goal-detail-outcome"]')!.textContent).toContain('적중');
  });

  it('⭐가설 구역은 고른 목표의 것으로 서고, 다른 목표를 고르면 그 목표의 것으로 바뀐다', async () => {
    stubMedia(true); stubFetch(); await mount();
    expect(hypothesesMock).toHaveBeenLastCalledWith({ epicId: 'g1', projectId: 'proj-1' });
    await click(titleBtn('g2'));
    expect(hypothesesMock).toHaveBeenLastCalledWith({ epicId: 'g2', projectId: 'proj-1' });
    expect(q('[data-testid="hypotheses-stub"]')!.getAttribute('data-epic')).toBe('g2');
  });

  it('⭐행을 누르면 상세가 바뀐다 — 페이지 이동(router.push)은 없다', async () => {
    stubMedia(true); stubFetch(); await mount();
    await click(titleBtn('g2'));
    expect(detailId()).toBe('g2');
    expect(rowOf('g2').querySelector('[aria-current="true"]')).not.toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
    // 행의 빈 자리를 눌러도 같다
    await click(rowOf('g3'));
    expect(detailId()).toBe('g3');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('⭐스토리는 고른 목표 것을 한 번 읽어 목록으로 보인다 · 누르면 일감 보드의 그 스토리로 간다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const calls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => /\/api\/goals\/g1$/.test(u));
    expect(calls.length).toBe(1);
    const stories = q('[data-testid="goal-detail-stories"]')!;
    expect(stories.textContent).toContain('인터뷰 질문지');
    expect(stories.textContent).toContain('포인트 3'); // 보드의 «포인트 {count}» 낱말 그대로(ko에 «SP» 약어를 두지 않는다 · #3922)
    expect(stories.textContent).toContain('진행 중'); // 보드의 상태 낱말
    // 스토리 진행(1/2가 아니라 목록 집계 1/6이 아니라 읽은 행 기준 1/2)과 SP 진행이 선다
    expect(q('[data-testid="goal-detail-progress"]')!.textContent).toContain('1/2');
    expect(q('[data-testid="goal-detail-progress"]')!.textContent).toContain('3/8');
    const btn = [...stories.querySelectorAll('button')].find((b) => b.textContent?.includes('모집 글'))!;
    await click(btn);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(String(pushMock.mock.calls[0]![0])).toContain('/flow?story=s2');
  });

  it('스토리를 못 읽으면 «불러오지 못했어요»로 정직하게(빈 목록으로 보이지 않는다)', async () => {
    stubMedia(true); stubFetch({ detail: () => ({ ok: false }) }); await mount();
    const stories = q('[data-testid="goal-detail-stories"]')!;
    expect(stories.textContent).toContain('스토리를 불러오지 못했어요');
    expect(stories.textContent).not.toContain('연결된 스토리가 없어요');
  });

  it('다른 프로젝트의 목표라고 답하면 그 스토리는 이 목표의 것으로 보이지 않는다', async () => {
    stubMedia(true); stubFetch({ detail: (id) => ({ ok: true, body: { data: { id, project_id: 'other-proj', stories: [{ id: 'x', title: '남의 스토리', status: 'done' }] } } }) }); await mount();
    const stories = q('[data-testid="goal-detail-stories"]')!;
    expect(stories.textContent).not.toContain('남의 스토리');
    expect(stories.textContent).toContain('스토리를 불러오지 못했어요');
  });

  it('⭐키보드: 목록 안에서 j / k로 고른 행이 움직이고 상세가 따라온다 · 초점은 행의 제목 단추로', async () => {
    stubMedia(true); stubFetch(); await mount();
    titleBtn('g1').focus();
    await key(titleBtn('g1'), 'j');
    expect(detailId()).toBe('g2');
    expect(document.activeElement).toBe(titleBtn('g2'));
    await key(document.activeElement!, 'k');
    expect(detailId()).toBe('g1');
    expect(document.activeElement).toBe(titleBtn('g1'));
    // 이름 있는 단추(끌기 손잡이 · 삭제)가 행의 첫 단추여도 초점은 제목으로 간다
    await key(titleBtn('g1'), 'ArrowDown');
    expect(document.activeElement).toBe(titleBtn('g2'));
  });

  it('상태 필터를 바꾸면 보이는 목표만 남고 상세는 그중 첫 목표로 옮겨 간다(사라진 목표를 붙들지 않는다)', async () => {
    stubMedia(true); stubFetch(); await mount();
    expect(detailId()).toBe('g1');
    await click(titleBtn('g2')); // 사람이 g2를 골라 둔 뒤에도 — 그 g2가 필터에 가려지면 상세가 g2를 붙들지 않는다
    expect(detailId()).toBe('g2');
    const doneBtn = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goals-status-filter"] button')].find((b) => b.textContent === '완료')!;
    await click(doneBtn);
    expect(rows().map((r) => r.getAttribute('data-row-key'))).toEqual(['g3', 'g4']);
    expect(detailId()).toBe('g3');
    expect(doneBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('⭐편집: 상세에서 «목표 수정» → 폼 → 저장하면 상세 · 행이 새 제목이 되고 행의 진척(1/6)은 그대로다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const edit = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goal-detail"] button')].find((b) => b.textContent === '목표 수정')!;
    await click(edit);
    expect(q('[data-testid="goal-detail"] form')).not.toBeNull();
    const form = q('[data-testid="goal-detail"] form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(q('[data-testid="goal-detail"] h2')!.textContent).toBe('고친 제목');
    expect(rowOf('g1').textContent).toContain('고친 제목');
    expect(rowOf('g1').textContent).toContain('1/6'); // 저장 응답에는 개수가 없다 — 행이 개수를 잃지 않는다
  });

  it('⭐다른 목표를 고르면 편집 폼 · 스토리 목록이 그 앞 목표 것으로 남지 않는다(목표마다 새로 선다)', async () => {
    stubMedia(true); stubFetch(); await mount();
    const edit = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goal-detail"] button')].find((b) => b.textContent === '목표 수정')!;
    await click(edit);
    expect(q('[data-testid="goal-detail"] form')).not.toBeNull();
    await click(titleBtn('g2'));
    expect(detailId()).toBe('g2');
    expect(q('[data-testid="goal-detail"] form')).toBeNull();
    expect(q('[data-testid="goal-detail-stories"]')!.textContent).not.toContain('인터뷰 질문지');
  });

  it('⭐상세의 진척 막대도 100%일 때 «완료 초록»이 아니다(작업이 끝난 것은 목표가 입증된 것이 아니다)', async () => {
    stubMedia(true); stubFetch(); await mount();
    await click(titleBtn('g3'));
    const progress = q('[data-testid="goal-detail-progress"]')!;
    expect(progress.textContent).toContain('4/4');
    expect(progress.querySelector('[data-slot="ds-progress-fill"]')!.className).toContain('bg-ds-action');
    expect(progress.querySelector('[data-slot="ds-progress-fill"]')!.className).not.toContain('bg-ds-done');
  });

  it('«전체 보기»는 그 목표 자신의 페이지 링크', async () => {
    stubMedia(true); stubFetch(); await mount();
    const a = [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="goal-detail"] a')].find((x) => x.textContent === '전체 보기')!;
    expect(a.getAttribute('href')).toBe('/ws-1/proj-1/goals/g1');
    expect(a.getAttribute('data-slot')).toBe('ds-button');
  });

  it('필터로 보이는 목표가 0개면 상세 열 없이 목록이 전폭(빈 열을 세우지 않는다)', async () => {
    stubMedia(true); stubFetch({ goals: [] }); await mount();
    expect(q('[data-testid="goals-detail-column"]')).toBeNull();
    expect(q('[data-testid="goals-list-column"]')!.className).not.toContain('lg:w-[420px]');
    expect(container.textContent).toContain('아직 목표가 없어요');
  });
});

describe('목표 화면 — 좁은 화면(폰): 행을 누르면 목표 자신의 페이지', () => {
  it('⭐상세 열이 없고(가설 · 스토리도 안 읽는다) 행을 누르면 /goals/[id]로 간다 · 목록은 한 벌', async () => {
    stubMedia(false); stubFetch(); await mount();
    expect(q('[data-testid="goals-detail-column"]')).toBeNull();
    expect(q('[data-testid="goal-detail"]')).toBeNull();
    expect(hypothesesMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => /\/api\/goals\/g1$/.test(u))).toBe(false);
    expect(rows().length).toBe(4); // 숨겨 둔 둘째 사본 없음
    await click(titleBtn('g2'));
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/goals/g2');
  });

  it('⭐j / k는 좁은 화면에서 아무 일도 하지 않는다(키만 눌러도 페이지가 열리지 않는다)', async () => {
    stubMedia(false); stubFetch(); await mount();
    titleBtn('g1').focus();
    await key(titleBtn('g1'), 'j');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('⭐폰 누름 영역: 머리의 보기 · 필터 단추와 행 제목 · 삭제가 ds 부품이라 touch:min-h-ds-touch(44 — 이름 있는 토큰)', async () => {
    stubMedia(false); stubFetch(); await mount();
    const ctl = qa('[data-testid="goals-head-controls"] button');
    expect(ctl.length).toBe(7); // 목록 · 스윔레인 + 전체 · 초안 · 활성 · 완료 · 보관
    for (const b of ctl) expect(b.className, b.textContent ?? '').toContain('touch:min-h-ds-touch');
    expect(titleBtn('g1').className).toContain('touch:min-h-ds-touch');
    const del = rowOf('g1').querySelector<HTMLElement>('button[aria-label="목표 삭제"]')!;
    expect(del.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(del.className).toContain('touch:min-h-ds-touch');
    expect(del.className).toContain('touch:min-w-ds-touch');
  });
});

describe('목표 화면 — 있던 동작이 그대로', () => {
  it('⭐삭제 트리거: human만 · 누르면 확인 창(행을 고르거나 페이지로 가지 않는다) · agent에는 없다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const del = rowOf('g2').querySelector<HTMLElement>('button[aria-label="목표 삭제"]')!;
    expect(del).not.toBeNull();
    await click(del);
    expect(pushMock).not.toHaveBeenCalled();
    expect(detailId()).toBe('g1'); // 삭제 단추를 눌렀다고 그 행이 골라지지 않는다
    expect(document.body.textContent).toContain('목표를 삭제할까요?');
  });

  it('agent면 삭제 트리거가 없다', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    stubMedia(true); stubFetch(); await mount();
    expect(container.querySelector('button[aria-label="목표 삭제"]')).toBeNull();
  });

  it('⭐끌기 손잡이: 전체 보기에서만 · 이름이 있다 · 눌러도 행이 골라지지 않는다 / 필터를 걸면 사라진다', async () => {
    stubMedia(true); stubFetch(); await mount();
    const grip = rowOf('g2').querySelector<HTMLElement>('button[aria-label="런칭 주간 준비 순서 변경"], button[aria-label*="런칭 주간 준비"]')!;
    expect(grip).not.toBeNull();
    expect(grip.getAttribute('data-slot')).toBe('ds-icon-button');
    await click(grip);
    expect(detailId()).toBe('g1');
    const doneBtn = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goals-status-filter"] button')].find((b) => b.textContent === '완료')!;
    await click(doneBtn);
    expect(container.querySelector('button[aria-label*="순서"]')).toBeNull();
  });

  it('보기 전환: 스윔레인으로 가면 머리(h1 · 보기 전환)는 그대로 하나, 상태 필터는 목록 보기에만', async () => {
    stubMedia(true); stubFetch(); await mount();
    const swim = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goals-view-switch"] button')].find((b) => b.textContent === '스윔레인')!;
    await click(swim);
    expect(qa('h1').length).toBe(1);
    expect(q('[data-testid="goals-status-filter"]')).toBeNull();
    expect(q('[data-testid="goals-swimlane-view"]')).not.toBeNull();
  });

  it('en 로케일에서도 머리와 행 · 상세 글이 나온다(ko/en 파리티)', async () => {
    stubMedia(true); stubFetch(); await mount('en');
    expect(q('[data-testid="goals-head"] h1')!.textContent).toBe(enMessages.goals.title);
    expect(q('[data-testid="goal-detail"]')!.textContent).toContain(enMessages.goals.description);
    expect(rowOf('g1').textContent).toContain('1/6');
  });
});
