// @vitest-environment jsdom
//
// story #2354 회귀 가드 — StoryDetailPanel의 새 `overlayPosition` prop이 (a) 기존 칸반
// 전체화면 드로어를 무변화로 유지하고(회귀 0, AC9) (b) 값을 주면 지도 위에 겹치는 소형
// 팝오버로 바뀌는지(배경 딤 없음·top/height 인라인 스타일 적용) 왕복 검증한다. 내부
// 콘텐츠(작업목록·댓글 등)의 정확성은 kanban-board.test.tsx가 이미 통합 경로로 커버하므로,
// 여기서는 이 PR이 건드린 «바깥 래퍼»만 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { bumpOrgSyncVersion } from '@/lib/project-context-client';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// story #2933 H2 — SSE push가 재조회를 "트리거"하는지 직접 잰다(verify-rail.test.tsx #2467
// respec과 동형 관례) — useSseNotifications를 모킹해 onExtraEvent 콜백을 손으로 쥐고 실행.
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: vi.fn(),
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

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

// kanban-board.test.tsx와 같은 관례 — 이 컴포넌트가 내부에서 부르는 나머지 fetch들
// (comments/activities/dependencies/hypotheses/gates 등)는 그레이스풀 폴백 경로만 타면
// 되므로 실패 응답으로 충분하다.
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
}

beforeEach(() => {
  stubFetch();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('StoryDetailPanel — overlayPosition (story #2354, 지도 위에 겹치는 팝오버)', () => {
  it('without overlayPosition: renders the existing full-screen drawer with a dimmed backdrop (칸반 회귀 0, AC9)', async () => {
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    const [backdrop, panel] = Array.from(container.querySelectorAll('[aria-hidden="true"], [role="dialog"]'));
    expect(backdrop?.className).toContain('bg-overlay-backdrop');
    expect(panel?.className).toContain('inset-0');
    expect(panel?.className).toContain('lg:right-0');
    expect((panel as HTMLElement)?.style.top).toBe('');
  });

  it('with overlayPosition: no dimmed backdrop, and the panel uses the given top/height instead of the full drawer classes (지도를 가리지 않는다)', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} overlayPosition={{ top: 120, heightPx: 300 }} />,
      ));
    });
    const backdrop = container.querySelector('[aria-hidden="true"]');
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(backdrop?.className).not.toContain('bg-overlay-backdrop');
    expect(backdrop?.className).not.toContain('backdrop-blur-sm');
    expect(panel.className).not.toContain('inset-0');
    expect(panel.className).not.toContain('lg:right-0');
    expect(panel.style.top).toBe('120px');
    expect(panel.style.height).toBe('300px');
  });

  it('overlay panel content is the SAME component internals — story title still renders (재사용 확認, AC7)', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory({ title: '겹침 패널 시험용 스토리' })} tasks={[]} onClose={() => {}} overlayPosition={{ top: 0, heightPx: 300 }} />,
      ));
    });
    expect(container.textContent).toContain('겹침 패널 시험용 스토리');
  });
});

// story #2528 — 전역 스크롤바 숨김(#2165) 하에 상세패널 본문 스크롤 컨테이너가 예외 목록에
// 없어 스크롤바가 안 보이던 결함. globals.css 범용 옵트인 `.scrollbar-visible` 클래스 적용
// 계약을 고정한다. jsdom은 실 스크롤바 렌더를 계산하지 않으므로 실제 가시성은 라이브 QA 몫
// (스토리 AC의 "라이브 픽셀 양성대조"가 결정적 게이트).
describe('StoryDetailPanel — #2528 본문 스크롤바 가시성', () => {
  it('본문 overflow-y-auto 컨테이너에 scrollbar-visible 클래스가 적용된다', async () => {
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    const body = Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('overflow-y-auto'));
    expect(body).toBeTruthy();
    expect(body?.className).toContain('scrollbar-visible');
  });

  it('겹침 팝오버 모드에서도 본문 스크롤 컨테이너의 클래스는 회귀 없이 유지된다', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} overlayPosition={{ top: 0, heightPx: 300 }} />,
      ));
    });
    const body = Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('overflow-y-auto'));
    expect(body?.className).toContain('scrollbar-visible');
  });
});

// story #2593(#2545 후속) — kanban `?story=` 딥링크로 이 패널이 콜드 하드네비 직후 열리면
// comments/activities/labels/references/dependencies/gates 6개 auto-mount fetch effect가
// switch-org 완료 前에 구 org_id로 먼저 발사될 수 있다. #2946과 동형 stale-guard(orgSyncVersion
// deps + cancelled 플래그)를 얹었는지를, "org-switch 신호 → 재요청 → 늦게 도착한 구 응답이
// 새 응답을 덮지 않는다"는 실제 레이스로 검증한다(대표로 comments effect 사용).
describe('StoryDetailPanel — org-switch 잔여 레이스 stale-guard (story #2593, #2545 후속)', () => {
  it('org-switch 재요청 이후 늦게 도착한 구 org 응답이 새 org 응답을 덮지 않는다', async () => {
    let resolveFirst: ((v: unknown) => void) | undefined;
    let resolveSecond: ((v: unknown) => void) | undefined;
    let commentsCallCount = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/comments?limit=20')) {
        commentsCallCount += 1;
        if (commentsCallCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return new Promise((resolve) => { resolveSecond = resolve; });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    expect(commentsCallCount).toBe(1); // 최초 마운트 — 구 org 요청(1st) 발사

    // DashboardShell의 switch-org 성공 신호 — orgSyncVersion 구독 effect가 재요청되어야 한다.
    await act(async () => { bumpOrgSyncVersion(); });
    expect(commentsCallCount).toBe(2); // 신 org 요청(2nd) 발사 확인 — 재요청 자체가 안 되면 여기서 실패(구코드 회귀)

    // 신 org 응답(2nd)이 먼저 도착
    await act(async () => {
      resolveSecond?.({ ok: true, json: async () => ({ data: [{ id: 'fresh', content: 'FRESH_ORG_COMMENT', created_by: 'u', created_at: '2026-01-01' }] }) });
    });
    const trigger = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Comments'));
    expect(trigger()?.textContent).toBe('Comments (1)');

    // 구 org 응답(1st)이 뒤늦게 도착 — cancelled라 무시돼야 fresh 상태가 안 덮인다.
    await act(async () => {
      resolveFirst?.({ ok: true, json: async () => ({ data: [{ id: 'stale', content: 'STALE_ORG_COMMENT', created_by: 'u', created_at: '2026-01-01' }] }) });
    });
    expect(trigger()?.textContent).toBe('Comments (1)'); // 여전히 1 — stale 응답이 2번째로 덮어쓰지 않았다
  });
});

// story #2933 H1(P0-H) — 구 FE 재파생(gate 목록+localStatus 조합, #3336 MEDIUM 드리프트
// 실사례로 이미 1회 버그난 그 로직)을 폐기하고 story.trust_stage(BE derive_trust_stage()
// 판정값)를 그대로 소비한다는 회귀가드. gate fetch를 몰라도(PO 조건① — 판정은 BE 한 곳)
// pipelineStage가 정확히 그 prop 값으로 뜨는지만 잰다.
describe('StoryDetailPanel — Workcell pipelineStage = story.trust_stage 직결(story #2933 H1)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  async function mountWithTrustStage(trustStage: KanbanStory['trust_stage']) {
    stubFetch();
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({ status: 'in-progress', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: trustStage })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  // 스테퍼가 6라벨을 항상 전부 렌더하므로(현재단계=스타일만 다름) textContent.toContain으로는
  // "어느 단계가 current인지" 못 잰다 — aria-current="step"이 붙은 그 원소의 텍스트로만 확인.
  // story #2984 §3/§6 — bentoLayout 기본값 true는 색 스테퍼(aria-current="step" 리스트)
  // 대신 물리량 게이지를 렌더한다(현재 단계 라벨은 data-testid="workcell-current-stage"
  // 한 곳). aria-current를 먼저 시도해 bentoLayout={false} 폴백 경로도 계속 커버한다 —
  // 이 SSE 라이브 갱신 테스트들의 관심사는 "어느 단계가 뜨는가"이지 스테퍼 시각 표현이
  // 아니므로 어느 레이아웃이든 같은 헬퍼로 잡는다.
  function currentStageLabel(): string | null {
    const legacy = container.querySelector('[aria-current="step"]')?.textContent?.trim();
    if (legacy) return legacy;
    return container.querySelector('[data-testid="workcell-current-stage"]')?.textContent?.trim() ?? null;
  }

  it('trust_stage="verified" → Verified(gate fetch 응답과 무관 — BE 판정값 그대로)', async () => {
    await mountWithTrustStage('verified');
    expect(currentStageLabel()).toBe('Verified');
  });

  it('trust_stage="needs_input" → Needs input', async () => {
    await mountWithTrustStage('needs_input');
    expect(currentStageLabel()).toBe('Needs input');
  });

  it('trust_stage=null(done/미지 status 또는 필드 미채움) → 스테퍼 자체가 안 뜬다(no-fiction, 지어낸 단계 0)', async () => {
    await mountWithTrustStage(null);
    expect(container.querySelector('[aria-current="step"]')).toBeNull();
  });

  it('trust_stage=undefined(구 응답 경로) → null과 동일하게 스테퍼 미표시(재파생 폴백 없음)', async () => {
    await mountWithTrustStage(undefined);
    expect(container.querySelector('[aria-current="step"]')).toBeNull();
  });
});

// story #2993(PO 확定①②, 2026-08-24, 선생님 실사고 「주전장이 안 보인다」) — 이전엔
// pipelineStage(=trust_stage null)와 proofHuman(human assignee 없음) 둘 중 하나만 없어도
// Workcell 전체가 사라졌다. 합성값(status 매핑 폴백·허구 human)을 만들지 않으면서 각자
// 정직한 빈 상태로 대체해 Workcell 자체는 항상 뜨는지 고정한다.
describe('StoryDetailPanel — Workcell 항상 렌더(story #2993)', () => {
  const HUMAN_ID = 'human-1';
  const AGENT_ID = 'agent-1';
  const memberMap = {
    [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' },
    [AGENT_ID]: { id: AGENT_ID, name: '에이전트군', type: 'agent' },
  };

  async function mount(storyOverrides: Partial<KanbanStory>) {
    stubFetch();
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({ status: 'in-progress', ...storyOverrides })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('에이전트만 배정(human 0)이어도 Workcell이 렌더되고 "책임자 미지정"이 정직하게 뜬다', async () => {
    await mount({ trust_stage: 'running', assignee_id: AGENT_ID, assignee_ids: [AGENT_ID] });
    expect(container.textContent).toContain('책임자 미지정');
    expect(container.textContent).toContain('에이전트군');
  });

  it('status=done(trust_stage=null)이어도 Workcell이 렌더되고 "파이프라인 범위 밖"이 정직하게 뜬다(합성 stage 없음)', async () => {
    await mount({ status: 'done', trust_stage: null, assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID] });
    expect(container.textContent).toContain('완료 — 신뢰 파이프라인 범위 밖');
  });

  it('human_owner_member_id가 있으면 assigneeIds 스캔보다 우선한다(PO 확定③, 실데이터 우선)', async () => {
    const OWNER_ID = 'owner-1';
    const map = { ...memberMap, [OWNER_ID]: { id: OWNER_ID, name: '진짜책임자', type: 'human' } };
    stubFetch();
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({
            status: 'in-progress', trust_stage: 'running',
            assignee_id: AGENT_ID, assignee_ids: [AGENT_ID],
            human_owner_member_id: OWNER_ID,
          })}
          tasks={[]} onClose={() => {}} memberMap={map}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('진짜책임자');
    expect(container.textContent).not.toContain('책임자 미지정');
  });

  it('human_owner_member_id가 memberMap에 없으면(미해결 참조) 지어내지 않고 다음 우선순위(assigneeIds)로 폴백한다', async () => {
    await mount({
      trust_stage: 'running', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID],
      human_owner_member_id: 'unresolvable-ghost-id',
    });
    expect(container.textContent).toContain('책임 책임자');
  });
});

// story #2933 H3(P0-H 정직성 감사, PO 부수기록ⓐ) — P0-04 in-flight 칩(trustChip, 제목 옆
// "입력 필요"/"병합 대기" 배지)도 구 gate-목록 재파생(deriveInFlightTrustChip, 폐기됨)이 아니라
// pipelineStage(=story.trust_stage, H1) 하나로 수렴했는지 고정. gate fetch 응답과 무관해야
// 한다(H1의 스테퍼 테스트와 동일 취지) — chipGates는 fetch 실패(stubFetch)로 항상 빈 배열.
describe('StoryDetailPanel — trustChip도 story.trust_stage로 수렴(story #2933 H3)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  async function mountWithTrustStage(trustStage: KanbanStory['trust_stage']) {
    stubFetch();
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({ status: 'in-progress', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: trustStage })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('trust_stage="needs_input" → "입력 필요" 칩(gate fetch는 항상 실패 응답 — 무관하게 뜬다)', async () => {
    await mountWithTrustStage('needs_input');
    expect(container.textContent).toContain('입력 필요');
  });

  it('trust_stage="merge_ready" → "병합 대기" 칩', async () => {
    await mountWithTrustStage('merge_ready');
    expect(container.textContent).toContain('병합 대기');
  });

  it('trust_stage="running"(needs_input/merge_ready 둘 다 아님) → 칩 자체가 안 뜬다', async () => {
    await mountWithTrustStage('running');
    expect(container.textContent).not.toContain('입력 필요');
    expect(container.textContent).not.toContain('병합 대기');
  });

  it('trust_stage=null(done 등) → 칩 미표시(TrustSeal과 동어반복 금지, 구 deriveInFlightTrustChip의 done 강제와 결과 동일)', async () => {
    await mountWithTrustStage(null);
    expect(container.textContent).not.toContain('입력 필요');
    expect(container.textContent).not.toContain('병합 대기');
  });

  // ⚠️QA changes(PR#3364, codex 교차모델, 2026-08-22) — 구 deriveInFlightTrustChip이 갖고
  // 있던 "status==='done'이면 무조건 null" 하드가드가 trustChip을 story.trust_stage 하나로
  // 수렴시키는 과정에서 소실됐다. handleChangeStatus의 낙관적 done 전이는 localStatus를 즉시
  // 'done'으로 바꾸지만(L915), story.trust_stage는 PATCH /status 응답이 돌아와 onStoryUpdate가
  // 호출될 때까지(그마저도 spread로 옛 값을 보존 — PO 조건②) 그대로 남는다 — 그 창에서
  // "done인데 in-flight 칩 표시"라는 부당 상태가 뜬다(codex 실물 재현). 이 테스트는 PATCH
  // 응답을 deferred로 붙잡아 그 창을 직접 관측한다.
  it('낙관적 done 전이 직후(trust_stage는 아직 옛값) — trustChip이 즉시 사라진다(localStatus 우선)', async () => {
    let resolveStatusPatch: ((v: unknown) => void) | undefined;
    const statusPatchPromise = new Promise((resolve) => { resolveStatusPatch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && /\/api\/stories\/s1\/status(\?|$)/.test(url)) {
        return statusPatchPromise as Promise<{ ok: boolean; json: () => Promise<unknown> }>;
      }
      return { ok: false, json: async () => null };
    }));

    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({ status: 'in-review', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'needs_input' })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('입력 필요'); // 전이 前 — 기존 칩 정상 표시.

    const statusTrigger = document.body.querySelector('button[aria-label="Status"], button[aria-label="상태"]') as HTMLButtonElement | null;
    expect(statusTrigger).toBeTruthy();
    await act(async () => { statusTrigger!.click(); });
    const doneItem = [...document.body.querySelectorAll('[role="menuitem"], button')]
      .find((el) => el.textContent?.trim() === '완료') as HTMLButtonElement | undefined;
    expect(doneItem).toBeTruthy();
    await act(async () => { doneItem!.click(); }); // handleChangeStatus('done') → localStatus 즉시 'done', PATCH는 deferred.

    // 낙관 전이 직후 — story.trust_stage(=pipelineStage)는 여전히 'needs_input'이지만
    // localStatus는 이미 'done'. 칩이 남아있으면 회귀.
    expect(container.textContent).not.toContain('입력 필요');
    expect(container.textContent).not.toContain('병합 대기');

    await act(async () => {
      resolveStatusPatch!({ ok: true, json: async () => ({ data: { violation: null } }) });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).not.toContain('입력 필요'); // PATCH 완료 後에도 계속 미표시.
  });
});

// story #2933 H2(P0-H) — Workcell 스테퍼가 `story.trust_stage_changed` SSE를 라이브 갱신
// 트리거로 쓰는지(AttentionQueueView, story #2923와 동형 패턴). SSE payload 자체는 신뢰의
// 소스가 아니다(트리거일 뿐) — REST 재조회(GET /api/stories/{id})의 값만 반영한다(PO 조건②
// 재파생 폴백 없음과 정합, verify-rail.test.tsx #2467 respec 관례 재사용).
describe('StoryDetailPanel — Workcell pipelineStage SSE 라이브 갱신(story #2933 H2)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  // story #2984 §3/§6 — bentoLayout 기본값 true는 색 스테퍼(aria-current="step" 리스트)
  // 대신 물리량 게이지를 렌더한다(현재 단계 라벨은 data-testid="workcell-current-stage"
  // 한 곳). aria-current를 먼저 시도해 bentoLayout={false} 폴백 경로도 계속 커버한다 —
  // 이 SSE 라이브 갱신 테스트들의 관심사는 "어느 단계가 뜨는가"이지 스테퍼 시각 표현이
  // 아니므로 어느 레이아웃이든 같은 헬퍼로 잡는다.
  function currentStageLabel(): string | null {
    const legacy = container.querySelector('[aria-current="step"]')?.textContent?.trim();
    if (legacy) return legacy;
    return container.querySelector('[data-testid="workcell-current-stage"]')?.textContent?.trim() ?? null;
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('story.trust_stage_changed(이 story_id) 수신 → 디바운스 後 GET /api/stories/{id} 재조회로 스테퍼가 갱신된다', async () => {
    const { useSseNotifications } = await import('@/hooks/use-sse-notifications');
    let capturedOnExtraEvent: ((eventName: string, data: unknown) => void) | undefined;
    (useSseNotifications as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (o: { onExtraEvent?: typeof capturedOnExtraEvent }) => { capturedOnExtraEvent = o.onExtraEvent; },
    );
    const story = makeStory({ id: 's-live', status: 'in-progress', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'running' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // 정확 일치만 — '/api/stories/s-live/comments' 등 하위 경로가 substring으로 오매칭돼
      // story payload를 comments state에 흘려보내면 안 된다(comments.map 크래시로 실제로 걸림).
      if (typeof url === 'string' && /\/api\/stories\/s-live(\?|$)/.test(url)) {
        return { ok: true, json: async () => ({ data: { ...story, trust_stage: 'needs_input' } }) };
      }
      return { ok: false, json: async () => null };
    }));

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={story} tasks={[]} onClose={() => {}} memberMap={memberMap} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(currentStageLabel()).toBe('Running');

    expect(capturedOnExtraEvent).toBeDefined();
    await act(async () => { capturedOnExtraEvent!('story.trust_stage_changed', { story_id: 's-live', new_stage: 'needs_input' }); });
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); await Promise.resolve(); });

    expect(currentStageLabel()).toBe('Needs input');
  });

  it('다른 story_id의 이벤트는 무시한다(이 패널이 보는 story 밖 전이)', async () => {
    const { useSseNotifications } = await import('@/hooks/use-sse-notifications');
    let capturedOnExtraEvent: ((eventName: string, data: unknown) => void) | undefined;
    (useSseNotifications as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (o: { onExtraEvent?: typeof capturedOnExtraEvent }) => { capturedOnExtraEvent = o.onExtraEvent; },
    );
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => null }));
    vi.stubGlobal('fetch', fetchMock);
    const story = makeStory({ id: 's-live', status: 'in-progress', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'running' });

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={story} tasks={[]} onClose={() => {}} memberMap={memberMap} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fetchMock.mockClear();

    await act(async () => { capturedOnExtraEvent!('story.trust_stage_changed', { story_id: 'other-story', new_stage: 'merge_ready' }); });
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });

    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/stories/s-live'), expect.anything());
    expect(currentStageLabel()).toBe('Running');
  });

  // PO 리뷰 MEDIUM(PR#3363, 2026-08-22) — story.id 변경 시 「대기 중 타이머」는 지워져도
  // 「이미 발화해 in-flight인 fetch」는 못 막는다. 늦게 도착한 응답이 새 story 패널에 옛
  // story의 stage를 override로 붙이는 레이스를 직접 재현한다: story A에서 SSE 발화→디바운스
  // 만료(fetch 발사)까지 간 다음, fetch가 아직 안 끝난 상태에서 story B로 전환(re-render)하고,
  // 그 뒤에야 story A의 응답이 도착하게 만든다 — story B 값이 안 덮이는지 확認.
  it('SSE로 쏜 fetch가 in-flight인 채 다른 story로 전환되면, 늦게 도착한 응답이 새 story를 덮지 않는다', async () => {
    const { useSseNotifications } = await import('@/hooks/use-sse-notifications');
    let capturedOnExtraEvent: ((eventName: string, data: unknown) => void) | undefined;
    (useSseNotifications as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (o: { onExtraEvent?: typeof capturedOnExtraEvent }) => { capturedOnExtraEvent = o.onExtraEvent; },
    );
    const storyA = makeStory({ id: 'story-a', status: 'in-progress', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'running' });
    const storyB = makeStory({ id: 'story-b', status: 'in-review', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'claimed_done' });

    // story-a의 fetch만 손으로 붙잡아 둔다(deferred) — story-b로 전환된 뒤에야 해소한다.
    let resolveStoryAFetch: ((v: unknown) => void) | undefined;
    const storyAFetchPromise = new Promise((resolve) => { resolveStoryAFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && /\/api\/stories\/story-a(\?|$)/.test(url)) {
        return storyAFetchPromise as Promise<{ ok: boolean; json: () => Promise<unknown> }>;
      }
      return { ok: false, json: async () => null };
    }));

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={storyA} tasks={[]} onClose={() => {}} memberMap={memberMap} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(currentStageLabel()).toBe('Running');

    // story-a SSE 발화 → 디바운스 500ms 소진 → fetch 발사(아직 안 끝남, deferred).
    await act(async () => { capturedOnExtraEvent!('story.trust_stage_changed', { story_id: 'story-a', new_stage: 'merge_ready' }); });
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });

    // story-a의 fetch가 in-flight인 채로 story-b로 전환(부모가 다른 카드를 클릭한 상황).
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={storyB} tasks={[]} onClose={() => {}} memberMap={memberMap} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(currentStageLabel()).toBe('Claimed done');

    // 이제야 story-a의 응답이 늦게 도착 — story-b 패널에 새면 안 된다.
    await act(async () => {
      resolveStoryAFetch!({ ok: true, json: async () => ({ data: { ...storyA, trust_stage: 'merge_ready' } }) });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(currentStageLabel()).toBe('Claimed done');
  });

  // PO 리뷰 확장(PR#3363 codex 교차모델, 2026-08-22) — 위 두 테스트가 덮는 "다른 story로
  // 전환" 레이스와 달리, 이건 **같은 story**에 연속 발화한 두 SSE 이벤트의 응답이 네트워크에서
  // 역순 도착하는 경우(E1→fetchA 보류→E2→fetchB→B 먼저 도착→A가 늦게 도착)다. story.id가
  // 안 바뀌므로 currentStoryIdRef 가드는 둘 다 통과시킨다 — AbortController가 fetchA 자체를
  // 죽여야(늦게 온 응답이 절대 반영되지 않아야) 막힌다.
  // ⚠️QA 2R(PR#3363, 카디르 뮤테이션+codex 교차모델 완전독립재현 일치, 2026-08-22) — 이전
  // 버전은 fetchB를 resolve한 뒤 fetchA를 **수동으로 rejectFirstCall!()**해 통과시켰는데,
  // 이 수동 거부가 abort 메커니즘의 실제 작동 여부와 무관하게 항상 같은 결과를 만들어
  // 동어반복이었다(프로덕션의 `fetchAbortRef.current?.abort()` 호출을 제거해도 21/21 그대로
  // 통과 — 회귀보호 0). 처방(codex 구체안): ①첫 fetch의 signal을 저장해 E2 후
  // `signal.aborted===true`를 수동 개입 없이 직접 assert ②수동 reject 완전 삭제 ③fetchA를
  // **성공 응답**으로 resolve해 진짜 역순 도착을 재현 — signal의 abort 리스너(실 fetch의
  // 네이티브 동작 시뮬레이션, 수동 개입 아님)가 실제로 먼저 그 promise를 죽였다면 이 resolve는
  // 이미-settled promise에 대한 무해한 no-op이고, 그게 아니라면(뮤테이션으로 abort()가
  // 빠지면) 이 resolve가 실제로 적용돼 UI가 부당하게 되돌아간다 — 뮤테이션 시 ①②(아래) 두
  // 경로 모두에서 확실히 실패한다.
  it('같은 story에 연속 발화한 두 SSE의 fetch가 역순 도착해도, 먼저 쏜(옛) fetch는 abort돼 나중 값(fetchB)이 유지된다', async () => {
    const { useSseNotifications } = await import('@/hooks/use-sse-notifications');
    let capturedOnExtraEvent: ((eventName: string, data: unknown) => void) | undefined;
    (useSseNotifications as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (o: { onExtraEvent?: typeof capturedOnExtraEvent }) => { capturedOnExtraEvent = o.onExtraEvent; },
    );
    const story = makeStory({ id: 'story-x', status: 'in-progress', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'running' });

    let callCount = 0;
    let firstSignal: AbortSignal | undefined;
    let resolveFirstCall: ((v: unknown) => void) | undefined;
    let resolveSecondCall: ((v: unknown) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (typeof url === 'string' && /\/api\/stories\/story-x(\?|$)/.test(url)) {
        callCount += 1;
        const thisCall = callCount;
        return new Promise((resolve, reject) => {
          if (thisCall === 1) { firstSignal = init?.signal; resolveFirstCall = resolve; }
          if (thisCall === 2) resolveSecondCall = resolve;
          // 실 fetch의 네이티브 동작 시뮬레이션(수동 개입 아님) — signal이 abort되면 그 즉시
          // pending promise가 죽는다. 프로덕션이 실제로 .abort()를 호출했을 때만 발동.
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={story} tasks={[]} onClose={() => {}} memberMap={memberMap} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(currentStageLabel()).toBe('Running');

    // E1 — 디바운스 소진 → fetchA 발사(deferred, 아직 안 끝남).
    await act(async () => { capturedOnExtraEvent!('story.trust_stage_changed', { story_id: 'story-x', new_stage: 'needs_input' }); });
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });
    expect(callCount).toBe(1);
    expect(firstSignal?.aborted).toBe(false); // 아직 E2 前 — abort 안 됨.

    // E2 — fetchA가 아직 in-flight인 채로 새 이벤트 발화 → 디바운스 재소진 시점에 fetchA를
    // abort하고 fetchB를 발사한다.
    await act(async () => { capturedOnExtraEvent!('story.trust_stage_changed', { story_id: 'story-x', new_stage: 'verified' }); });
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });
    expect(callCount).toBe(2);
    // ①수동 개입 없는 직접 assert — 프로덕션이 실제로 이전 컨트롤러를 abort했는지.
    expect(firstSignal?.aborted).toBe(true);

    // fetchB(나중 이벤트) 먼저 도착 — 최신값(Verified) 반영.
    await act(async () => {
      resolveSecondCall!({ ok: true, json: async () => ({ data: { ...story, trust_stage: 'verified' } }) });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(currentStageLabel()).toBe('Verified');

    // ③fetchA(먼저 쏜 옛 fetch)를 성공 응답으로 resolve — 진짜 역순 «성공» 도착 재현(수동
    // reject 없음). 진짜 abort됐다면(firstSignal.aborted===true, 위에서 이미 확認) 이
    // promise는 abort 리스너가 이미 reject해 settled 상태라 이 resolve 시도는 무해한 no-op.
    await act(async () => {
      resolveFirstCall!({ ok: true, json: async () => ({ data: { ...story, trust_stage: 'needs_input' } }) });
      await Promise.resolve(); await Promise.resolve();
    });
    // ②늦은 «성공» 응답이 부당 반영되지 않았는지 — Verified 유지.
    expect(currentStageLabel()).toBe('Verified');
  });
});

// story #2922 W2 — Evidence 구획 = ProofCapsule density="full" 실배선. glance-hero.tsx의
// buildEvidence/buildTrustSeal와 동일 no-fiction 규율(신호 없는 필드는 렌더 안 함)을 판다.
describe('StoryDetailPanel — Workcell Evidence 구획 실배선(story #2922 W2)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  async function mountEvidence(storyOverrides: Record<string, unknown>, gates: Array<Record<string, unknown>>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/gates?work_item_id=')) {
        return { ok: true, json: async () => gates };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => {
      root.render(wrap(
        // story #2933 H1 — Workcell 자체가 pipelineStage(=story.trust_stage) 없으면 렌더 안
        // 되므로(no-fiction 게이트), 이 스위트의 실제 대상(Evidence 구획)과 무관하게 값을
        // 채워 Workcell을 띄운다. storyOverrides가 trust_stage를 명시하면 그게 우선.
        <StoryDetailPanel
          story={makeStory({ status: 'in-review', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'claimed_done', ...storyOverrides })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('pending merge 게이트(risk_grade=high) → 게이트 액션 버튼이 그 게이트로 링크된다', async () => {
    await mountEvidence({}, [{ id: 'gate-1', gate_type: 'merge', status: 'pending', risk_grade: 'high', neutral_facts: {} }]);
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/gates/gate-1');
    expect(link).toBeTruthy();
    expect(link?.textContent).toContain('Merge gate');
  });

  it('merge 게이트가 이미 resolved면 게이트 버튼을 다시 안 띄운다(no-fiction — 끝난 결정을 대기 중처럼 보이면 안 됨)', async () => {
    await mountEvidence({ human_verified: true, human_verified_by: HUMAN_ID, human_verified_at: '2026-08-20T00:00:00Z' }, [
      { id: 'gate-1', gate_type: 'merge', status: 'approved', risk_grade: 'high', neutral_facts: {} },
    ]);
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/gates/gate-1');
    expect(link).toBeFalsy();
  });

  it('human_verified → TrustSeal이 검증자 실명으로 렌더된다(주장이 아니라 검증)', async () => {
    await mountEvidence({ human_verified: true, human_verified_by: HUMAN_ID, human_verified_at: '2026-08-20T00:00:00Z' }, [
      { id: 'gate-1', gate_type: 'merge', status: 'approved', neutral_facts: {} },
    ]);
    expect(container.textContent).toContain('책임자');
  });

  it('merge 게이트 neutral_facts.ci_result=pass → Evidence autoVerify passed 신호가 렌더된다', async () => {
    await mountEvidence({ self_reported: true }, [{ id: 'gate-1', gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'pass' } }]);
    // ProofCapsule FullVariant의 evidence.autoVerify==='passed' 렌더 텍스트(proofCapsule.evidence.autoPassed).
    expect(container.textContent).toMatch(/자동|검증|passed/i);
  });

  it('신호가 하나도 없으면(게이트 0·self_reported/human_verified 둘 다 false) 정직한 빈 상태 그대로다', async () => {
    await mountEvidence({}, []);
    expect(container.textContent).toContain('아직 증거 없음');
  });
});

// story #2922 W5 — GET /{id}/references?direction=outgoing 응답을 ChatProofSection과 동일
// parseStoryProofReferences로 재해석해 Workcell Conversation 구획 요약(건수+링크)을 채운다.
// 전용 fetch 신설 없이 기존 outgoingRefs 왕복에 편승하는 배선이 실제로 도는지 mount로 검증.
describe('StoryDetailPanel — Workcell Conversation 구획 대화근거 요약 배선(story #2922 W5)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  async function mountWithReferences(referencesJson: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/references?direction=outgoing')) {
        return { ok: true, json: async () => referencesJson };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => {
      root.render(wrap(
        // story #2933 H1 — Workcell 자체가 pipelineStage(=story.trust_stage) 없으면 렌더 안
        // 되므로(no-fiction 게이트), 이 스위트의 실제 대상(Conversation 구획)과 무관하게
        // 값을 채워 Workcell을 띄운다.
        <StoryDetailPanel
          story={makeStory({ status: 'in-review', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], trust_stage: 'claimed_done' })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('proof 참조가 있으면 Workcell Conversation 구획에 건수+링크가 렌더된다', async () => {
    await mountWithReferences({
      data: [{
        id: 'ref-1', created_at: '2026-08-20T00:00:00Z', form: 'proof', target_type: 'chat_message', still_exists: true,
        proof_payload: {
          conversation_id: 'conv-1', start_message_id: 'msg-1',
          snapshot: [{ message_id: 'msg-1', author_id: 'a1', content: 'hi', created_at: '2026-08-20T00:00:00Z' }],
        },
      }],
    });
    // href만으로는 아래 독립 ChatProofSection(같은 엔드포인트 소비)도 동일 href를 만들어
    // 확실한 구분자가 못 된다 — Workcell 전용 문구("대화 근거 N건 보기", ChatProofSection의
    // "대화 근거 · 날짜"와 다른 문구)를 가진 링크로 좁힌다.
    const link = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/chats/conv-1?messageId=msg-1' && a.textContent?.includes('대화 근거 1건 보기'),
    );
    expect(link).toBeTruthy();
  });

  it('proof 참조가 0건이면 "연결된 대화 없음"이 정직하게 뜬다(침묵 아님)', async () => {
    await mountWithReferences({ data: [] });
    expect(container.textContent).toContain('연결된 대화 없음');
  });
});
