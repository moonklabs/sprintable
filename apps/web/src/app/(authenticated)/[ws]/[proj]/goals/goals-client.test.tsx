// @vitest-environment jsdom
//
// story 3995840c(doc resource-view-firsttouch-identity-pattern §4 "에픽"→"목표" 행): 빈 목록
// first-touch가 제네릭 카피 대신 5요소(아이콘+headline+explainer+그룹hint+CTA) 정체성
// explainer로 렌더되는지, 필터 적용 중 결과 0건(진짜 빈 프로젝트 아님)은 별개의 중립 카피를
// 쓰는지(no-fiction), 데이터 있으면 완전 무변화인지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { HOVER_REVEAL } from '@/lib/hover-reveal';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// story #4888 — 상세 열의 가설 구역은 목표 페이지와 같이 쓰는 별도 부품이다(여기서는 자리만)
vi.mock('@/components/hypotheses/hypotheses-section', () => ({ HypothesesSection: () => null }));

vi.mock('./goals-context', () => ({
  useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// story #2104 — HumanOnlyAction(에픽 삭제 트리거를 감싼다)이 useDashboardContext를 읽는다.
// 기본은 human(기존 스위트가 전부 "리스트가 정상 렌더된다"만 확認하므로 무관). agent 게이팅
// 자체를 보는 케이스만 개별 override.
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubFetch(epics: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/goals?')) {
      return { ok: true, json: async () => ({ data: epics }) };
    }
    return { ok: false, json: async () => null };
  }));
}

function stubMedia(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide && /min-width:\s*1024px/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
}

beforeEach(() => {
  pushMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('GoalsClient — 목표 first-touch 정체성', () => {
  it('진짜 빈 프로젝트(목표 0건)면 5요소 explainer로 렌더된다 — 구 제네릭 카피 소거', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 목표가 없어요');
    expect(html).toContain('목표는 이루려는 하나의 큰 성과예요');
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0); // Flag 아이콘 + 그룹hint
    expect(html).not.toContain('에픽'); // 8fc51517: "에픽" 잔존 소거
  });

  it('필터로 인한 결과 0건(진짜 빈 프로젝트 아님)은 중립 카피를 쓴다 — "아직 시작 안 함" 오해 방지(no-fiction)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    // story #2017: 필터 탭이 raw status 값('draft')을 그대로 렌더하던 버그를 고쳐 KO 로케일에선
    // 번역된 라벨('초안')로 렌더된다 — 이 테스트도 그 정정에 맞춰 갱신.
    const draftFilterButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '초안');
    expect(draftFilterButton).not.toBeUndefined();
    await act(async () => { draftFilterButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const html = container.innerHTML;
    expect(html).toContain(koMessages.goals.noGoalsFiltered);
    // 정체성 explainer(진짜 빈상태 전용 카피)는 여기 새면 안 됨 — 목표가 실재하는데 "시작 안 함"은 거짓.
    expect(html).not.toContain('아직 목표가 없어요');
  });

  it('데이터 있으면 기존 리스트가 그대로 렌더되고 explainer는 미노출된다(회귀 0)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('E-CANVAS');
    expect(html).not.toContain('아직 목표가 없어요');
  });

  // story #2104 — BE goals.py:352(human-only 삭제 403)를 FE가 미리 안 보고 에이전트 계정에도
  // 삭제 트리거를 무조건 열었다(#2091/#2103과 같은 결함). 양방향 고정 — human까지 잠그면
  // 정당한 삭제가 봉쇄되는 더 큰 사고다.
  it('human이면 에픽 삭제 트리거가 렌더된다(정당한 사용자는 막히면 안 됨)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    expect(container.querySelector('button[aria-label="목표 삭제"]')).not.toBeNull();
  });

  it('agent면 에픽 삭제 트리거가 안 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    expect(container.querySelector('button[aria-label="목표 삭제"]')).toBeNull();
  });

  // [SID:4345] 목표 삭제는 `hidden group-hover:flex`였다 — display:none이라 터치에선 늘 없고 키보드 탭 순서에서도 빠졌다.
  // 이제 HOVER_REVEAL(호버 없는 기기에선 늘 · 마우스는 행 호버 · 초점). story #4888 — 삭제 단추는 ds 아이콘 단추(초점 링 · 폰 누름 영역 44는 부품이 가진다). jsdom은 CSS를 안 입혀서 클래스 모양으로 핀한다.
  it('human 삭제 트리거 = HOVER_REVEAL · ds 아이콘 단추(터치 44) · hidden 0 · 탭 순서 안([SID:4345])', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    const del = container.querySelector<HTMLButtonElement>('button[aria-label="목표 삭제"]')!;
    const tokens = del.className.split(/\s+/);
    for (const t of HOVER_REVEAL.split(' ')) expect(tokens, t).toContain(t);
    expect(tokens).not.toContain('hidden');
    expect(tokens).not.toContain('group-hover:flex');
    expect(del.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(tokens).toEqual(expect.arrayContaining(['touch:min-h-11', 'touch:min-w-11']));
    expect(del.tabIndex).toBe(0);
    expect(del.closest('.group')).not.toBeNull();
  });
});

describe('GoalsClient — 결과 원장 재조립(§2 이중 신호 · story #4888 머리 · ds 칩)', () => {
  it('머리(h1 + 활성/완료 수)가 한 덩이로 렌더된다 — 옛 마스트헤드 kicker는 없다', async () => {
    // story #3126 — 활성 카운트는 status='active'뿐 아니라 latest_story_activity_at이 dormancy 임계 안(최근 움직임 실재)이어야 센다. 이 목표A는 방금 움직였다는 신호.
    stubFetch([
      { id: 'e1', title: '목표A', status: 'active', total_stories: 2, done_stories: 1, latest_story_activity_at: new Date().toISOString() },
      { id: 'e2', title: '목표B', status: 'done', total_stories: 4, done_stories: 4 },
    ]);
    await mount();
    expect(container.textContent).not.toContain('목표 · 결과');
    expect(container.textContent).not.toContain('OUTCOMES');
    expect(container.querySelector('h1')?.textContent).toBe('목표');
    expect(container.textContent).toContain('활성 1');
    expect(container.textContent).toContain('완료 1');
  });

  it('story #3126: an active-status goal with NO recent story movement(latest_story_activity_at 없음/dormancy 밖) is NOT counted in 활성 — 52개 중 실제로 도는 것만 센다', async () => {
    stubFetch([
      { id: 'e1', title: '목표A(방금 움직임)', status: 'active', total_stories: 2, done_stories: 1, latest_story_activity_at: new Date().toISOString() },
      { id: 'e2', title: '목표B(오래 조용함)', status: 'active', total_stories: 3, done_stories: 0, latest_story_activity_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() },
      { id: 'e3', title: '목표C(신호 자체 없음)', status: 'active', total_stories: 1, done_stories: 0 },
    ]);
    await mount();
    // status='active' 3개 중 실제로 최근 움직인 것은 1개뿐 — "3 active"가 아니라 "1 active".
    expect(container.textContent).toContain('활성 1');
  });

  // 두 축(작업 / 결과)은 섞이지 않는다 — 작업 막대는 100%여도 «완료 초록»이 아니고, 초록은 결과 «적중» 칩 하나에만 있다(soul-lock).
  const tones = () => [...container.querySelectorAll('[data-slot="ds-chip"]')].map((c) => c.getAttribute('data-tone'));
  const rowChips = () => [...container.querySelectorAll('[data-testid="goal-row"] [data-slot="ds-chip"]')];

  it('작업(Claimed) 막대는 done=100%여도 green이 아니다(ds 진행 막대의 «완료 초록»을 쓰지 않는다)', async () => {
    stubFetch([{ id: 'e1', title: '완료된 목표', status: 'done', total_stories: 4, done_stories: 4, outcome_status: 'pending' }]);
    await mount();
    const fill = container.querySelector('[data-testid="goal-row"] [data-slot="ds-progress-fill"]')!;
    expect(fill.className).toContain('bg-ds-action');
    expect(fill.className).not.toContain('bg-ds-done');
  });

  it('결과(Verified) 칩 — outcome_status=hit이면 «적중»이 done(초록) 톤이다', async () => {
    stubFetch([{ id: 'e1', title: '달성 목표', status: 'done', total_stories: 2, done_stories: 2, outcome_status: 'hit' }]);
    await mount();
    const chip = rowChips().find((c) => c.textContent === '적중')!;
    expect(chip.getAttribute('data-tone')).toBe('done');
  });

  // PR#3387 카디르 QA(2026-08-23)·PO soul-lock 확定 — «빨강이 아니다»와 «초록이 아니다»는 다른 주장이라 둘 다 잰다.
  it('결과 칩 — outcome_status=miss는 빨강도 초록도 아니라 중립 톤이다(soul-lock)', async () => {
    stubFetch([{ id: 'e1', title: '미달 목표', status: 'done', total_stories: 2, done_stories: 2, outcome_status: 'miss' }]);
    await mount();
    const chip = rowChips().find((c) => c.textContent === '빗나감')!;
    expect(chip.getAttribute('data-tone')).toBe('neutral');
    expect(tones()).not.toContain('failed');
    expect(tones()).not.toContain('done');
  });

  // PR#3387 처방 — status==='done'만으론 상태 칩이 green이면 안 된다. outcome_status별 명시 케이스(done+miss · done+unmeasured · done+pending)로 고정.
  it.each(['miss', 'unmeasured', 'pending'] as const)('상태 칩 — done+%s는 초록이 아니라 중립(점 있는 칩)이다', async (outcome) => {
    stubFetch([{ id: 'e1', title: 'S', status: 'done', total_stories: 1, done_stories: 1, outcome_status: outcome }]);
    await mount();
    const statusChip = rowChips().find((c) => c.querySelector('[data-chip-dot]'))!;
    expect(statusChip.textContent).toBe('완료');
    expect(statusChip.getAttribute('data-tone')).toBe('neutral');
    expect(tones()).not.toContain('done');
  });

  it('상태 칩 — done+hit이어도 상태 칩 자체는 done(초록) 톤이 아니다(두 축 분리) · 초록은 결과 칩 하나뿐', async () => {
    stubFetch([{ id: 'e1', title: 'H', status: 'done', total_stories: 1, done_stories: 1, outcome_status: 'hit' }]);
    await mount();
    const statusChip = rowChips().find((c) => c.querySelector('[data-chip-dot]'))!;
    expect(statusChip.getAttribute('data-tone')).not.toBe('done');
    expect(tones().filter((x) => x === 'done')).toHaveLength(1);
  });

  it('결과 미측정+measure_after 있으면 "측정 예정 · 날짜"를 보여준다(수치 지어내지 않음)', async () => {
    stubFetch([{ id: 'e1', title: '진행 목표', status: 'active', total_stories: 3, done_stories: 1, outcome_status: 'pending', measure_after: '2026-09-01' }]);
    await mount();
    expect(container.textContent).toContain('측정 예정');
  });

  it('작업 100%인데 결과 미측정이면 두 신호가 동시에 눈에 띈다(§2 핵심 가치)', async () => {
    stubFetch([{ id: 'e1', title: '일은 끝 결과는 아직', status: 'done', total_stories: 5, done_stories: 5, outcome_status: 'unmeasured' }]);
    await mount();
    expect(container.textContent).toContain('5/5');
    expect(container.textContent).toContain('판정 없이 닫힘');
  });
});

// story #3005(로드맵 P2·PR-C, L2) → story #4888 — 방금 만든 목표: 넓은 화면이면 상세 열에 서고(그 막대도 «완료 초록»이 아닌 무채/action), 좁은 화면이면 그 목표의 페이지가 열린다.
// (행을 눌러 여는 길은 goals-screen.4888.test — 여기는 «만들기 플로우가 끝나면 어디로 가는가»)
describe('GoalsClient — 방금 만든 목표가 서는 곳(story #4888)', () => {
  async function createViaForm(existing: unknown[] = [], beforeCreate?: () => Promise<void>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (typeof url === 'string' && url.includes('/api/goals?')) return { ok: true, json: async () => ({ data: existing }) };
      if (url === '/api/goals' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            data: {
              id: 'e1', title: '진행 목표', status: 'active', priority: 'medium', created_at: '2026-08-24',
              stories: [
                { id: 's1', title: 'A', status: 'done' },
                { id: 's2', title: 'B', status: 'done' },
                { id: 's3', title: 'C', status: 'in-progress' },
                { id: 's4', title: 'D', status: 'in-progress' },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    if (beforeCreate) await beforeCreate();
    const createBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.goals.newGoal));
    await act(async () => { createBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const titleInput = document.body.querySelector('input[type="text"][data-slot="input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(titleInput, '진행 목표');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = titleInput.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('넓은 화면: 생성 직후 상세 열에 그 목표가 서고 진척 막대는 «2/4» · 완료 초록이 아니다(물리량 게이지)', async () => {
    stubMedia(true);
    await createViaForm();
    expect(pushMock).not.toHaveBeenCalled();
    const progress = container.querySelector('[data-testid="goal-detail-progress"]')!;
    expect(progress).not.toBeNull();
    expect(progress.textContent).toContain('2/4');
    const fill = progress.querySelector('[data-slot="ds-progress-fill"]')!;
    expect(fill.className).toContain('bg-ds-action');
    expect(fill.className).not.toContain('bg-ds-done');
    expect(container.querySelector('[data-testid="goal-detail"] h2')!.textContent).toBe('진행 목표');
  });

  it('⭐넓은 화면: 다른 목표를 골라 둔 뒤 만들어도 방금 만든 목표가 상세 열에 선다(골라 둔 것이 붙들지 않는다)', async () => {
    stubMedia(true);
    const existing = [{ id: 'e0', title: '먼저 있던 목표', status: 'active', priority: 'medium', created_at: '2026-08-01', total_stories: 2, done_stories: 0 }];
    await createViaForm(existing, async () => {
      const row = container.querySelector('[data-testid="goal-row"][data-row-key="e0"] [data-row-focus]') as HTMLElement;
      await act(async () => { row.click(); });
      expect(container.querySelector('[data-testid="goal-detail"]')!.getAttribute('data-goal-id')).toBe('e0');
    });
    expect(container.querySelector('[data-testid="goal-detail"]')!.getAttribute('data-goal-id')).toBe('e1');
  });

  it('⭐생성 응답에 스토리가 이미 있으면 상세 열은 같은 목표를 또 읽지 않는다(방금 받은 것을 그대로 쓴다)', async () => {
    stubMedia(true);
    await createViaForm();
    const reads = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).filter((u) => /\/api\/goals\/e1$/.test(u));
    expect(reads).toHaveLength(0);
  });

  it('⭐좁은 화면: 생성 직후 그 목표의 페이지가 열린다(행을 누를 때와 같은 길) · 상세 열은 없다', async () => {
    stubMedia(false);
    await createViaForm();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/ws-1/proj-1/goals/e1');
    expect(container.querySelector('[data-testid="goal-detail"]')).toBeNull();
  });
});

// story #3005(로드맵 P2·PR-C, L1) → story #4888 — 목표 행은 ds 목록 행(평평한 줄)이라 카드 그림자(--elev-card)가 없다. 끌고 있는 행만 떠 있는 그림자(--elev-overlay) — 드래그는 jsdom 합성 이벤트로 안정 재현이 안 되는
// 기지 한계라 비드래그 축만 유닛으로 고정한다.
describe('GoalsClient — 행은 평평한 줄이다(카드 그림자 없음)', () => {
  it('비드래그 상태의 목표 행에는 그림자 클래스가 없다', async () => {
    stubFetch([{ id: 'e1', title: '목표A', status: 'active', total_stories: 2, done_stories: 1 }]);
    await mount();
    const row = container.querySelector('[data-testid="goal-row"]')!;
    expect(row.className).not.toMatch(/shadow/);
    expect(row.querySelector('[data-slot="ds-list-row"]')!.className).toContain('border-b');
    expect(container.querySelector('.shadow-lg')).toBeNull();
    expect(container.querySelector('.shadow-\\[var\\(--elev-card\\)\\]')).toBeNull();
  });
});

// story #3945(#3942 배포 92 디자인 감사) — TopBarSlot 브레드크럼 라벨이 본문 제목과 같이 <h1>이라 페이지에 h1이 2개(개념적으로 다른 두 제목)였다(헤딩 위계 위반).
// TopBarSlot은 위에서 <div>로만 목업하므로(title을 그대로 렌더) 이 테스트가 실제로 그 중복 클래스를 재현·고정한다.
// story #4888 — 목록 보기가 데스크톱 · 모바일 두 사본이 아니라 한 장이 되어, 보이는 h1은 정확히 1개다(예전엔 반응형 쌍 2개).
describe('GoalsClient — 페이지 h1 1개 원칙(story #3945)', () => {
  it('⭐h1은 정확히 1개(머리의 «목표») — TopBarSlot 브레드크럼은 h1을 안 만든다', async () => {
    stubFetch([{ id: 'e1', title: '목표A', status: 'active', total_stories: 2, done_stories: 1 }]);
    await mount();
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe('목표');
    expect(h1s[0]!.closest('[data-testid="goals-head"]')).not.toBeNull();
    // TopBarSlot 라벨 특유의 className(text-sm font-medium)을 가진 h1은 0개여야 한다
    expect(h1s.some((h) => h.className.includes('text-sm font-medium'))).toBe(false);
  });

  // story #3946(유나 확認·페드루 정정) — 로디드 스냅샷만 재면 로딩 분기(머리가 아직 안 그려진 순간)에서 h1이 0개가 되는 gap을 못 잡는다. fetch를 고의로 pending 상태로 묶어 두고 «첫 렌더 직후(아직 응답 전)»를 그대로 잰다.
  it('⭐로딩 상태에도 h1이 정확히 1개다(sr-only 자리표시자)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { GoalsClient } = await import('./goals-client');
    await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toContain('sr-only');
    expect(h1s[0]!.textContent).toBe('목표');
  });
});

describe('[SID:4388] GoalsClient — the chosen status filter is announced as pressed', () => {
  it('the first filter («all») starts pressed; clicking the second moves aria-pressed to it', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    const row = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '전체')!.parentElement!;
    const pressed = () => Array.from(row.querySelectorAll(':scope > button')).map((b) => b.getAttribute('aria-pressed'));
    const count = pressed().length;
    expect(count).toBeGreaterThan(2);
    expect(pressed()).toEqual(['true', ...Array(count - 1).fill('false')]);

    await act(async () => { (row.querySelectorAll(':scope > button')[1] as HTMLButtonElement).click(); });
    expect(pressed()).toEqual(['false', 'true', ...Array(count - 2).fill('false')]);
  });
});
