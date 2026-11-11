// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면 본체 마무리) — 스프린트 상세 패널의 남은 칸을 ds 부품으로: 목표 블록(손 카드 rounded-lg border bg-muted/20) → ds Card,
// 가설 게이트(rounded-xl 점선 손 카드) → 점선 ds Card + ds Button, 스프린트 스토리 줄 · 백로그 줄(손 카드 li) → ds ListRow(compact),
// 연결 해제(이름 없는 raw 단추 X) → 이름 있는 ds IconButton(폰 44), 배정 · 더 보기 → ds Button.
// 새 기능 0 · 값 · 조건 · 요청 모양(PATCH /api/stories/{id} {sprint_id})은 그대로 — 이 시험이 그걸 못박는다.
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
const TC = koMessages.common;
const PLANNING = { id: 's1', title: '계획 스프린트', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14', goal: '첫 사용자 열 명을 만난다' };
const CLOSED = { id: 's2', title: '끝난 스프린트', status: 'closed', start_date: '2026-06-01', end_date: '2026-06-14' };
const SPRINT_STORIES = [
  { id: 'st-1', title: '가입 화면 고치기', story_points: 5, sprint_id: 's1' },
  { id: 'st-2', title: '결제 연결', story_points: null, sprint_id: 's1' },
];
const BACKLOG = [{ id: 'bk-1', title: '뉴스레터 첫 글', story_points: 2, sprint_id: null }];
let patches: Array<{ url: string; body: unknown }>;
let sprintStoriesMeta: { hasMore?: boolean; nextCursor?: string | null };
let hypotheses: unknown[];

beforeEach(() => {
  patches = [];
  sprintStoriesMeta = {};
  hypotheses = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (typeof url !== 'string') return { ok: false, json: async () => null };
    if (init?.method === 'PATCH') { patches.push({ url, body: JSON.parse(init.body ?? 'null') }); return { ok: true, json: async () => ({ data: {} }) }; }
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [PLANNING, CLOSED] }) };
    if (url.includes('/hypotheses')) return { ok: true, json: async () => ({ data: hypotheses }) };
    if (url.includes('/burndown')) return { ok: false, json: async () => null };
    if (url.includes('/api/stories/backlog')) return { ok: true, json: async () => ({ data: BACKLOG }) };
    if (url.includes('/api/stories')) return { ok: true, json: async () => ({ data: url.includes('sprint_id=s2') ? [{ id: 'st-9', title: '닫힌 스프린트의 스토리', story_points: 3, sprint_id: 's2' }] : SPRINT_STORIES, meta: sprintStoriesMeta }) };
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
async function open(title: string) {
  await mount();
  const li = [...container.querySelectorAll('li')].find((x) => x.textContent?.includes(title))!;
  await act(async () => { li.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}
const detail = () => container.querySelector('h2')?.closest('div.flex-col') as HTMLElement;
const rows = (scope: HTMLElement) => [...scope.querySelectorAll('[data-slot="ds-list-row"]')] as HTMLElement[];
const btn = (scope: HTMLElement, label: string) => [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined;
const cls = (e: Element) => e.className.split(/\s+/);

describe('스프린트 상세 패널 남은 칸 — ds 부품(story #4888)', () => {
  it('⭐목표 블록이 ds Card이고 목표 글이 그대로다 — 손 카드(bg-muted/20)가 아니다', async () => {
    await open('계획 스프린트');
    const card = [...detail().querySelectorAll('[data-slot="ds-card"]')].find((c) => (c.textContent ?? '').includes(PLANNING.goal));
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain(S.goalLabel);
    expect(detail().querySelectorAll('.bg-muted\\/20')).toHaveLength(0);
  });

  it('⭐가설 게이트(계획 중 + 가설 0)가 점선 ds Card이고 «가설 추가»가 ds Button이다 — 손 카드(rounded-xl border-info-border)가 아니다', async () => {
    await open('계획 스프린트');
    const gate = [...detail().querySelectorAll('[data-slot="ds-card"]')].find((c) => (c.textContent ?? '').includes(S.declareGateQuestion)) as HTMLElement;
    expect(gate).toBeTruthy();
    expect(cls(gate)).toContain('border-dashed');
    expect(detail().querySelectorAll('[class*="border-info-border"]')).toHaveLength(0);
    const add = btn(gate, S.declareAddCta)!;
    expect(add).toBeTruthy();
    expect(add.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(add)).toContain('touch:min-h-ds-touch');
  });

  it('가설이 이미 있으면 가설 게이트가 나오지 않는다(예전과 같은 조건)', async () => {
    hypotheses = [{ id: 'h1', statement: 'x', status: 'proposed' }];
    await open('계획 스프린트');
    expect([...detail().querySelectorAll('[data-slot="ds-card"]')].some((c) => (c.textContent ?? '').includes(S.declareGateQuestion))).toBe(false);
  });

  it('⭐스프린트 스토리가 ds ListRow(compact)이고 제목 · SP가 그대로다(SP 없는 스토리는 SP 글 없음)', async () => {
    await open('계획 스프린트');
    const stories = rows(detail()).filter((r) => (r.textContent ?? '').includes('가입 화면 고치기') || (r.textContent ?? '').includes('결제 연결'));
    expect(stories).toHaveLength(2);
    for (const r of stories) expect(r.getAttribute('data-density')).toBe('compact');
    expect(stories.find((r) => (r.textContent ?? '').includes('가입 화면 고치기'))!.textContent).toContain('5SP');
    expect(stories.find((r) => (r.textContent ?? '').includes('결제 연결'))!.textContent).not.toContain('SP');
  });

  it('⭐연결 해제가 이름(제거) 있는 ds 아이콘 단추(폰 44)이고, 누르면 PATCH {sprint_id:null} 후 백로그로 옮겨 간다', async () => {
    await open('계획 스프린트');
    const row = rows(detail()).find((r) => (r.textContent ?? '').includes('가입 화면 고치기'))!;
    const un = row.querySelector(`button[aria-label="${S.unassign}"]`) as HTMLButtonElement;
    expect(un).toBeTruthy();
    expect(un.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(cls(un)).toContain('touch:min-h-ds-touch');
    await act(async () => { un.click(); });
    await flush();
    expect(patches).toEqual([{ url: '/api/stories/st-1', body: { sprint_id: null } }]);
    expect(rows(detail()).some((r) => (r.textContent ?? '').includes('가입 화면 고치기') && r.querySelector(`button[aria-label="${S.unassign}"]`))).toBe(false);
    expect(rows(detail()).some((r) => (r.textContent ?? '').includes('가입 화면 고치기') && btn(r, S.assign))).toBe(true);
  });

  it('⭐백로그 줄이 ds ListRow이고 «추가»가 ds Button이며, 누르면 PATCH {sprint_id:스프린트}로 스프린트 쪽으로 옮겨 간다', async () => {
    await open('계획 스프린트');
    const row = rows(detail()).find((r) => (r.textContent ?? '').includes('뉴스레터 첫 글'))!;
    expect(row).toBeTruthy();
    const assign = btn(row, S.assign)!;
    expect(assign.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(assign)).toContain('touch:min-h-ds-touch');
    await act(async () => { assign.click(); });
    await flush();
    expect(patches).toEqual([{ url: '/api/stories/bk-1', body: { sprint_id: 's1' } }]);
    expect(rows(detail()).some((r) => (r.textContent ?? '').includes('뉴스레터 첫 글') && r.querySelector(`button[aria-label="${S.unassign}"]`))).toBe(true);
  });

  it('⭐닫힌 스프린트에는 백로그 배정도 연결 해제도 없다(예전과 같은 조건)', async () => {
    await open('끝난 스프린트');
    // 줄은 있는데(스토리 1개) 연결 해제는 없다 — 단언이 비어 있지 않다
    expect(rows(detail()).some((r) => (r.textContent ?? '').includes('닫힌 스프린트의 스토리'))).toBe(true);
    expect(detail().querySelector(`button[aria-label="${S.unassign}"]`)).toBeNull();
    expect(rows(detail()).some((r) => (r.textContent ?? '').includes('뉴스레터 첫 글'))).toBe(false);
  });

  it('⭐스프린트 스토리가 더 있으면 «더 보기»가 ds Button(폭 가득)이다', async () => {
    sprintStoriesMeta = { hasMore: true, nextCursor: 'c1' };
    await open('계획 스프린트');
    const more = btn(detail(), TC.loadMore)!;
    expect(more).toBeTruthy();
    expect(more.getAttribute('data-slot')).toBe('ds-button');
    expect(cls(more)).toContain('w-full');
  });

  it('⭐검증 중인 가설 칸(OpenLoopCockpit): 가설마다 ds Card(측정 중만 점선), 판정 · 지표 · 실험이 ds Chip이고 글이 그대로다', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    hypotheses = [
      { id: 'h1', statement: '가입 전환이 오른다', status: 'measuring', metric: '가입 전환율', measure_after: soon },
      { id: 'h2', statement: '결제 이탈이 준다', status: 'verified' },
    ];
    await open('계획 스프린트');
    const cards = [...detail().querySelectorAll('[data-slot="ds-card"]')].filter((c) => (c.textContent ?? '').includes('가입 전환이 오른다') || (c.textContent ?? '').includes('결제 이탈이 준다')) as HTMLElement[];
    expect(cards).toHaveLength(2);
    const measuring = cards.find((c) => (c.textContent ?? '').includes('가입 전환이 오른다'))!;
    const verified = cards.find((c) => (c.textContent ?? '').includes('결제 이탈이 준다'))!;
    expect(cls(measuring)).toContain('border-dashed');
    expect(cls(verified)).not.toContain('border-dashed');
    const chipTexts = (c: Element) => [...c.querySelectorAll('[data-slot="ds-chip"]')].map((x) => (x.textContent ?? '').trim());
    expect(chipTexts(measuring)).toContain(koMessages.retro.hVerdictMeasuring);
    expect(chipTexts(measuring)).toContain('가입 전환율');
    expect(chipTexts(verified)).toContain(koMessages.retro.hVerdictVerified);
    // SOUL-LOCK: 검증됨만 done 색, 나머지는 중립(반증 · 폐기에 실패색을 입히지 않는다)
    expect(verified.querySelector('[data-slot="ds-chip"]')!.getAttribute('data-tone')).toBe('done');
    expect(measuring.querySelector('[data-slot="ds-chip"]')!.getAttribute('data-tone')).toBe('neutral');
    // 측정 예정 D-N
    expect(measuring.textContent).toMatch(/측정 예정 D-\d+/);
  });

  it('⭐실험 칩(연결 스토리 제목)이 ds Chip이고 «실험» 라벨이 그대로다', async () => {
    hypotheses = [{ id: 'h1', statement: '가입 전환이 오른다', status: 'measuring' }];
    await open('계획 스프린트');
    expect(detail().textContent).toContain(S.cockpitExperimentsLabel);
    const chips = [...detail().querySelectorAll('[data-slot="ds-chip"]')].map((x) => (x.textContent ?? '').trim());
    expect(chips).toContain('가입 화면 고치기');
    expect(chips).toContain('결제 연결');
    expect(detail().querySelectorAll('span.bg-background.rounded-md, span.bg-muted\\/50')).toHaveLength(0);
  });

  it('⭐상세 패널에 손으로 만든 카드 행(rounded-lg border li)이 남아 있지 않다', async () => {
    await open('계획 스프린트');
    expect(detail().querySelectorAll('li.rounded-lg, li[class*="border-dashed"]')).toHaveLength(0);
  });
});
