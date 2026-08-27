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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

beforeEach(() => {
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
    expect(html).toContain('이 상태의 목표가 없습니다.');
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
});

// story #2958(doc goals-outcome-ledger-redesign-handoff §2/§3) — 진척바 → 이중 신호(작업
// Claimed/결과 Verified) 재조립 회귀가드.
describe('GoalsClient — 결과 원장 재조립(§2 이중 신호·§3 마스트헤드)', () => {
  it('마스트헤드(kicker+H1+dek)가 목표 활성/완료 카운트와 함께 렌더된다', async () => {
    // story #3126 — 활성 카운트는 status='active'뿐 아니라 latest_story_activity_at이
    // dormancy 임계 안(최근 움직임 실재)이어야 센다. 이 목표A는 방금 움직였다는 신호.
    stubFetch([
      { id: 'e1', title: '목표A', status: 'active', total_stories: 2, done_stories: 1, latest_story_activity_at: new Date().toISOString() },
      { id: 'e2', title: '목표B', status: 'done', total_stories: 4, done_stories: 4 },
    ]);
    await mount();
    expect(container.textContent).toContain('OUTCOMES');
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

  // story #2974 §1/§3(PR-D0) — 마스트헤드 h1이 font-display 토큰 경유(D0=Pretendard, 시각 무변화).
  // ⚠️h1이 이 화면에 2개 존재(TopBarSlot title도 h1이고 같은 t('title') 텍스트라 textContent로는
  // 안 갈린다) — querySelector('h1')이 어느 쪽을 줄지 보장 없어 크기 클래스(text-[28px])로 특정.
  // delta(PO/유나 지적 2026-08-24) — font-editorial-heading(무게 유틸, 820)도 같이 있어야
  // 한다(family-only 치환이 무게 820→400을 조용히 지웠던 회귀 재발 방지).
  it('마스트헤드 h1이 font-display+font-editorial-heading 둘 다 경유한다(#2974 D0 배선)', async () => {
    stubFetch([{ id: 'e1', title: '목표A', status: 'active', total_stories: 2, done_stories: 1 }]);
    await mount();
    const mastheadH1 = [...container.querySelectorAll('h1')].find((h1) => h1.className.includes('text-[28px]'));
    expect(mastheadH1?.className).toContain('font-display');
    expect(mastheadH1?.className).toContain('font-editorial-heading');
  });

  it('작업(Claimed) 바는 중립색(proof-ink-3)이지 primary(파랑)가 아니다 — done=100%여도 green 아님', async () => {
    stubFetch([{ id: 'e1', title: '완료된 목표', status: 'done', total_stories: 4, done_stories: 4, outcome_status: 'pending' }]);
    await mount();
    const fill = container.querySelector('.bg-proof-ink-3');
    expect(fill).not.toBeNull();
    expect(container.querySelector('.bg-primary')).toBeNull();
  });

  // story #3099(DS·AA 후속) — green 소형텍스트 AA 미달로 text-proof-ink 중립화(#3090과 동형).
  // "적중" 문구 자체가 이미 의미를 병기하므로 색 손실은 아니다.
  it('결과(Verified) 줄 — outcome_status=hit이면 "적중" 텍스트가 중립 톤(text-proof-ink)으로 뜬다', async () => {
    stubFetch([{ id: 'e1', title: '달성 목표', status: 'done', total_stories: 2, done_stories: 2, outcome_status: 'hit' }]);
    await mount();
    expect(container.textContent).toContain('적중');
    expect(container.querySelector('.text-proof-ink')).not.toBeNull();
    expect(container.querySelector('.text-proof-green')).toBeNull();
  });

  // PR#3387 카디르 QA(2026-08-23)·PO soul-lock 확定 — 이 테스트가 "text-destructive 없음"만
  // 잰 게 구멍이었다(done+miss가 status 칩에서 green으로 뜨는 실회귀를 놓침). green 클래스
  // 자체가 없다는 걸 직접 잰다 — "빨강이 아니다"와 "초록이 아니다"는 다른 주장이다.
  it('결과(Verified) 줄 — outcome_status=miss는 빨강도 초록도 아니라 중립 톤이다(soul-lock)', async () => {
    stubFetch([{ id: 'e1', title: '미달 목표', status: 'done', total_stories: 2, done_stories: 2, outcome_status: 'miss' }]);
    await mount();
    expect(container.textContent).toContain('빗나감');
    expect(container.querySelector('.text-destructive')).toBeNull();
    expect(container.querySelector('.bg-proof-green-soft')).toBeNull();
    expect(container.querySelector('.text-proof-green')).toBeNull();
  });

  // PR#3387 QA 처방 ①② — status==='done'만으론 상태 칩이 green이면 안 된다. outcome_status별
  // 명시 케이스로 고정(회귀 재발 시 바로 여기서 걸린다).
  it('상태 칩 — done+miss는 초록이 아니라 중립(faint dot)이다', async () => {
    stubFetch([{ id: 'e1', title: 'M', status: 'done', total_stories: 1, done_stories: 1, outcome_status: 'miss' }]);
    await mount();
    expect(container.querySelector('.bg-proof-green-soft')).toBeNull();
    // story #3053(2984-S5) — MaterialChip 채택 후 상태 칩은 항상 헤어라인(border-proof-line
    // bg-transparent)이고, active/비active 구분은 내부 dot(bg-proof-blue/bg-proof-faint)이
    // 짊어진다 — bg-proof-sunk 채움 자체가 이제 없다(옛 fill 규율의 흔적 제거).
    expect(container.querySelector('.bg-proof-faint')).not.toBeNull();
    expect(container.querySelector('.bg-proof-sunk')).toBeNull();
  });

  it('상태 칩 — done+unmeasured는 초록이 아니라 중립(faint dot)이다', async () => {
    stubFetch([{ id: 'e1', title: 'U', status: 'done', total_stories: 1, done_stories: 1, outcome_status: 'unmeasured' }]);
    await mount();
    expect(container.querySelector('.bg-proof-green-soft')).toBeNull();
    // story #3053(2984-S5) — MaterialChip 채택 후 상태 칩은 항상 헤어라인(border-proof-line
    // bg-transparent)이고, active/비active 구분은 내부 dot(bg-proof-blue/bg-proof-faint)이
    // 짊어진다 — bg-proof-sunk 채움 자체가 이제 없다(옛 fill 규율의 흔적 제거).
    expect(container.querySelector('.bg-proof-faint')).not.toBeNull();
    expect(container.querySelector('.bg-proof-sunk')).toBeNull();
  });

  it('상태 칩 — done+pending(아직 판정 없음)은 초록이 아니라 중립(faint dot)이다', async () => {
    stubFetch([{ id: 'e1', title: 'P', status: 'done', total_stories: 1, done_stories: 1, outcome_status: 'pending' }]);
    await mount();
    expect(container.querySelector('.bg-proof-green-soft')).toBeNull();
    // story #3053(2984-S5) — MaterialChip 채택 후 상태 칩은 항상 헤어라인(border-proof-line
    // bg-transparent)이고, active/비active 구분은 내부 dot(bg-proof-blue/bg-proof-faint)이
    // 짊어진다 — bg-proof-sunk 채움 자체가 이제 없다(옛 fill 규율의 흔적 제거).
    expect(container.querySelector('.bg-proof-faint')).not.toBeNull();
    expect(container.querySelector('.bg-proof-sunk')).toBeNull();
  });

  // PR#3387 처방 갱신(유나 원작자 정본 채택, PO 2026-08-23) — 미르코의 첫 처방("done&&hit만
  // green")조차 두 축(작업/결과)을 섞는 것이었다. 최종 규율: **상태 칩은 green을 아예 안 쓴다**
  // (done+hit이어도) — green은 결과 필(OutcomeStatusBadge, bg-success-tint)에만 존재한다.
  // ⚠️story #7d7634ee(P0) 작업 중 실측 발견 — 이 두 테스트는 `.proof-cut-xs` 셀렉터로 상태
  // 칩을 찾았으나, story #3053(2984-S5)이 이미 상태 칩을 MaterialChip(proof-cut 계열 아님,
  // rounded-md 헤어라인)으로 교체해서 origin/develop HEAD 기준으로도 이미 죽은 셀렉터였다
  // (querySelector가 null 반환 → 두 테스트 다 무단언으로 조용히 깨져 있었음, #3399 clip-path
  // 가드는 그 기제 자체가 이 요소엔 원래 없었으니 통째로 무의미해 삭제 — 아래 첫 테스트만
  // MaterialChip의 새 `data-slot="material-chip"` 훅으로 셀렉터 갱신해 되살린다).
  it('상태 칩 — done+hit이어도 상태 칩 자체엔 green 클래스가 없다(두 축 분리)', async () => {
    stubFetch([{ id: 'e1', title: 'H', status: 'done', total_stories: 1, done_stories: 1, outcome_status: 'hit' }]);
    await mount();
    expect(container.querySelector('[data-slot="material-chip"]')?.className).not.toContain('proof-green');
  });

  it('green은 결과 필(OutcomeStatusBadge)에서만 뜬다 — outcome=hit일 때 bg-success-tint가 존재', async () => {
    stubFetch([{ id: 'e1', title: 'H', status: 'done', total_stories: 1, done_stories: 1, outcome_status: 'hit' }]);
    await mount();
    expect(container.querySelector('.bg-success-tint')).not.toBeNull();
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

// story #3005(로드맵 P2·PR-C, L2) — 상세 패널의 스토리진행/SP진행 ProgressBar(위 "작업(Claimed)"
// 바와는 별개 컴포넌트)도 물리량이라 proof-blue(bg-primary)가 아니라 무채(bg-proof-ink-3)여야
// 한다.
describe('GoalsClient — 로드맵 P2·PR-C L2(스토리진행/SP진행 ProgressBar 무채화)', () => {
  // GoalDetailPanel(스토리진행/SP진행 ProgressBar가 사는 곳)은 행 클릭이 아니라(그건 라우터
  // 딥링크로 나가버림, AC5) 생성 직후 onCreated 콜백으로만 이 컴포넌트 트리 안에서 열린다 —
  // 생성 플로우를 실제로 태워서 연다.
  it('생성 직후 열리는 상세 패널의 스토리진행 바가 bg-proof-ink-3를 쓰고 bg-primary는 안 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (typeof url === 'string' && url.includes('/api/goals?')) return { ok: true, json: async () => ({ data: [] }) };
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

    const createBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.goals.newGoal));
    await act(async () => { createBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const titleInput = document.body.querySelector('input[type="text"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(titleInput, '진행 목표');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = titleInput.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // ⚠️같은 화면에 이미 무채인 "작업(Claimed)" 바(§2, GoalRow)가 별도로 존재해 document 전체
    // .bg-proof-ink-3 grep은 그 바로 오탐한다 — done/total 텍스트("2 / 4")로 이 ProgressBar
    // 인스턴스 자신의 wrapper만 좁혀서 잰다.
    const doneTotal = [...document.body.querySelectorAll('span')].find((s) => s.textContent === '2 / 4');
    expect(doneTotal).toBeTruthy();
    const wrapper = doneTotal!.closest('.space-y-1')!;
    expect(wrapper.querySelector('.bg-proof-ink-3')).toBeTruthy();
    expect(wrapper.querySelector('.bg-primary')).toBeNull();
  });
});

// story #3005(로드맵 P2·PR-C, L1) — 에픽 행(카드)은 rest 상태에서 --elev-card를 쓴다. dragging=true
// 축은 dnd-kit useSortable이 실 포인터 시퀀스에 걸려 jsdom 합성 이벤트로 안정 재현이 안 되는
// 기지 한계([[feedback-render-test-over-source-grep]]류 synthetic dnd-kit 불안정 교훈, STEER
// 작업 당시 확인) — rest(비드래그) 축만 유닛으로 고정하고 드래그 중 elev-overlay 전환은 라이브
// 픽셀로 검증한다.
describe('GoalsClient — 로드맵 P2·PR-C L1(에픽 카드 elevation 토큰, rest 축)', () => {
  it('비드래그 상태의 에픽 행이 --elev-card를 쓰고 shadow-lg 리터럴은 안 쓴다', async () => {
    stubFetch([{ id: 'e1', title: '목표A', status: 'active', total_stories: 2, done_stories: 1 }]);
    await mount();
    const row = [...container.querySelectorAll('div')].find((d) => d.className.includes('shadow-[var(--elev-card)]'));
    expect(row).toBeTruthy();
    expect(container.querySelector('.shadow-lg')).toBeNull();
  });
});
