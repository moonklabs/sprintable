// @vitest-environment jsdom
//
// story #2224 AC1(2026-07-31, 멀티레인 재구조) — 이 화면의 몸통이 「목표 하나를 고르는
// 픽 패널+단일 캔버스」에서 「30일 안 변화 있는 목표 전부를 레인으로 동시에 그리는
// FlowMultiLaneCanvas」로 바뀌었다. NextMakerScreen 자신의 책임(fetch 오케스트레이션→
// 파생→헤드라인/그룹핑 계산→orphan 패널)만 값으로 닫는다 — 레인 자체의 fetch/렌더는
// flow-multi-lane-canvas.test.tsx가 따로 본다(FlowMultiLaneCanvas는 여기서 얇은 스텁으로
// 대체 — kanban-board/flow-node-story-panel을 얇게 스텁하는 flow-client.test.tsx와 같은 결).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NextMakerScreen } from './next-maker-screen';
import { bumpOrgSyncVersion } from '@/lib/project-context-client';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./flow-multi-lane-canvas', () => ({
  FlowMultiLaneCanvas: ({ expandGoals, foldedCount }: { expandGoals: { id: string; title: string }[]; foldedCount: number }) => (
    <div data-testid="multi-lane-canvas-stub">
      <span data-testid="expand-titles">{expandGoals.map((g) => g.title).join(',')}</span>
      <span data-testid="folded-count">{foldedCount}</span>
    </div>
  ),
}));

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

// "지금"에 상대적인 날짜 — 30일 창 판정이 실행 시각에 안 흔들리게(고정 날짜 fixture는
// 테스트를 실행하는 날에 따라 창을 넘나드는 취약점이 있다).
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const GOALS = [
  { id: 'e-recent', title: 'E-Recent', status: 'active', total_stories: 10, done_stories: 2 },
  { id: 'e-stale', title: 'E-Stale', status: 'active', total_stories: 5, done_stories: 1 },
  { id: 'e-empty', title: 'E-Empty', status: 'active', total_stories: 0, done_stories: 0 },
  // 라이브 결함 fix(2026-07-31) 회귀 가드 — 이미 닫힌 목표가 "다음이 없는" 목표로 잘못
  // 세지 않는지를 이 fixture가 지킨다.
  { id: 'e-closed', title: 'E-Closed', status: 'done', total_stories: 3, done_stories: 3 },
  { id: 'e-archived', title: 'E-Archived', status: 'archived', total_stories: 4, done_stories: 4 },
];

function makeStory(overrides: Partial<{
  id: string; story_number: number; title: string; status: string;
  assignee_id: string | null; updated_at: string; epic_id: string | null;
}> = {}) {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog',
    assignee_id: null, updated_at: daysAgoIso(5), epic_id: 'e-recent',
    ...overrides,
  };
}

function buildFetchMock(
  calledUrls: string[],
  patchBodies: unknown[] = [],
  // 까심 QA REQUEST_CHANGES(2026-07-31) 회귀 가드용 — 「다음으로」 PATCH의 응답을 시나리오별로
  // 흔들기 위한 훅. 'fail'=HTTP 비-ok 응답, 'throw'=네트워크 자체가 끊김(unhandled rejection 재현).
  promoteStatusMode: 'ok' | 'fail' | 'throw' = 'ok',
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calledUrls.push(url);
    if (init?.method === 'PATCH' && init.body) patchBodies.push(JSON.parse(String(init.body)));

    if (url.startsWith('/api/goals?')) {
      return jsonResponse({ data: GOALS, meta: { hasMore: false, nextCursor: null, limit: 100 } });
    }
    if (url.startsWith('/api/stories?')) {
      if (url.includes('status=backlog')) {
        return jsonResponse({
          data: [
            makeStory({ id: 'b1', story_number: 101, epic_id: 'e-recent', updated_at: daysAgoIso(5) }),
            makeStory({ id: 'b2', story_number: 102, epic_id: 'e-stale', updated_at: daysAgoIso(60) }),
            // 목표(epic) 없는 orphan — 「목표 정하기」패널의 대상.
            makeStory({ id: 'o1', story_number: 401, epic_id: null, title: 'Orphan Story' }),
          ],
          meta: { hasMore: false, nextCursor: null, limit: 100 },
        });
      }
      if (url.includes('status=ready-for-dev')) {
        return jsonResponse({ data: [], meta: { hasMore: false, nextCursor: null, limit: 100 } });
      }
      if (url.includes('status=in-progress')) {
        return jsonResponse({ data: [], meta: { hasMore: false, nextCursor: null, limit: 100 } });
      }
      if (url.includes('status=in-review')) {
        return jsonResponse({ data: [], meta: { hasMore: false, nextCursor: null, limit: 100 } });
      }
    }
    if (url.startsWith('/api/reference-candidates/next-up')) {
      return jsonResponse([]);
    }
    if (url.startsWith('/api/analytics/epics-progress-lane')) {
      return jsonResponse({ data: { epics: {}, zones: {}, stall_threshold_hours: 168, stories_without_epic: 0 } });
    }
    // NextActionsStrip을 펼치면(GoalStemCard 마운트) 부르는 것들 — 승격 후보 계산 + 그 목표의
    // 단일-레인 캔버스는 showCanvas=false라 여기선 안 뜨지만 reference-candidates는 그대로 부른다.
    if (url.startsWith('/api/goals/') && url.includes('/reference-candidates')) {
      return jsonResponse([]);
    }
    if (url.startsWith('/api/analytics/epic-flow-nodes')) {
      return jsonResponse({ data: { epic_id: 'e-recent', now: { total: 0, items: [] }, upcoming: { total: 0, items: [] }, past: { total: 0 } } });
    }
    if (url.startsWith('/api/dependencies/graph')) {
      return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
    }
    if (url.includes('/status') && init?.method === 'PATCH') {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (body.status === 'ready-for-dev' && promoteStatusMode === 'throw') throw new Error('network down');
      if (body.status === 'ready-for-dev' && promoteStatusMode === 'fail') return jsonResponse({ error: 'boom' }, false);
      return jsonResponse({ data: { id: 'b1', status: body.status } });
    }
    if (url.includes('/transition') && init?.method === 'POST') {
      return jsonResponse({ data: { id: 'e-quiet', status: 'done' } });
    }
    if (/^\/api\/stories\/[^/]+$/.test(url) && init?.method === 'PATCH') {
      return jsonResponse({ data: { id: 'o1', epic_id: 'e-recent' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('NextMakerScreen — real fetch orchestration + lane grouping', () => {
  it('fetches goals + 4 active-status story pages + next-up + lane data, and computes the headline from them', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u.startsWith('/api/goals?'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('status=backlog'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('status=ready-for-dev'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/api/reference-candidates/next-up'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/api/analytics/epics-progress-lane'))).toBe(true);

    // e-recent/e-stale/e-empty 셋 다 「다음이 없다」(ready-for-dev 없음 — 헤드라인은 스토리
    // 유무와 무관하게 hasNext만 본다, 레인 그룹핑과는 다른 축) — e-closed(done)/e-archived
    // (archived)는 절대 안 들어간다 — totalGoals는 3(active뿐)이지 5가 아니다.
    expect(container.textContent).toContain('목표 3개 중 3개에');
  });

  // story #2352 회귀 가드(2026-07-31, 유나 적발) — 옛 라벨 "문이 닫혀 막힌"이 관제서랍의
  // "게이트·막힘 신호"와 같은 낱말("막힘")을 써서, 한 화면에 28과 0이 동시에 뜨는
  // 자기모순이 났다(다른 표를 세면서 같은 말을 씀). 0단계 카드는 이제 "승인 대기"로
  // 부르고, 관제서랍(다른 표를 세던 축) 자체는 화면에서 걷어냈다 — "막힘"이라는 문자열이
  // 화면 어디에도 안 뜬다.
  it('labels the Gate-based zero-stage card "승인 대기" (not "막힘") and shows no "막힘" text anywhere on screen', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('승인 대기');
    expect(container.textContent).not.toContain('막힘');
  });

  it('splits goals into expand(30일 안 변화)/fold(그 외) and passes them to FlowMultiLaneCanvas — a totally empty goal (0 stories) goes into NEITHER', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    // e-recent(스토리 5일 전 변화)는 펼침, e-stale(60일 전)은 접힘, e-empty(스토리 0건)는
    // «레인 캔버스»의 어느 쪽에도 안 들어간다(PO 정정 — 「접힘」과 「0건」은 다른 사정).
    // NextActionsStrip(승격/전환 동사)은 별도 축이라 e-empty도 「다음이 없다」로 뜬다 —
    // 스토리가 0건이라도 그 목표가 조용한지/승격 후보가 없는지는 여전히 물을 수 있다.
    expect(container.querySelector('[data-testid="expand-titles"]')?.textContent).toBe('E-Recent');
    expect(container.querySelector('[data-testid="folded-count"]')?.textContent).toBe('1');
  });

  // story #2535(E-FLOW-V4 S5) — 지구→대륙→도시 드릴다운 착지. focusGoalId가 fold 쪽에
  // 떨어진 목표(e-stale)를 가리키면 «그 목표 하나만» 강제로 expand로 옮긴다 — 다른 레인은
  // 안 건드린다(카드 폭발 회피를 구조로).
  it('focusGoalId — a normally-folded goal is force-expanded when it matches, and only that one', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} focusGoalId="e-stale" />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const expandTitles = container.querySelector('[data-testid="expand-titles"]')?.textContent;
    expect(expandTitles).toContain('E-Recent');
    expect(expandTitles).toContain('E-Stale');
    expect(container.querySelector('[data-testid="folded-count"]')?.textContent).toBe('0');
  });

  it('focusGoalId that matches an already-expanded goal changes nothing(no duplicate)', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} focusGoalId="e-recent" />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('[data-testid="expand-titles"]')?.textContent).toBe('E-Recent');
    expect(container.querySelector('[data-testid="folded-count"]')?.textContent).toBe('1');
  });

  // 유나 라이브 실측(2026-07-31, AC17-B 재정정 — 선생님 직접 지적) — "지도가 가장 높은
  // 블록"으로만 재던 판정이 «자리»(어디에 있는가)를 안 물어, 캔버스 y=2108(뷰포트
  // 900) — 레인이 한 조각도 첫 화면에 없는 사고가 났다. 캔버스가 DOM에서 헤드라인보다
  // «먼저» 오는 것 자체를 값으로 고정한다(순서가 바뀌면 다시 아래로 밀릴 수 있다).
  it('AC17-B: the multi-lane canvas renders BEFORE the headline/strip in DOM order (canvas is the top block, not just the tallest)', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const html = container.innerHTML;
    const canvasIdx = html.indexOf('multi-lane-canvas-stub');
    const headlineIdx = html.indexOf('목표 3개 중');
    expect(canvasIdx).toBeGreaterThan(-1);
    expect(headlineIdx).toBeGreaterThan(-1);
    expect(canvasIdx).toBeLessThan(headlineIdx);
  });

  it('orphan panel: assigning a goal PATCHes /api/stories/[id] with epic_id and the story disappears from the orphan list', async () => {
    const calledUrls: string[] = [];
    const patchBodies: unknown[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls, patchBodies));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('목표에 안 붙은 일이 1건 있습니다');

    const summaryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('목표에 안 붙은 일이'));
    await act(async () => {
      summaryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('Orphan Story');
    const pickButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '목표 정하기');
    expect(pickButton).toBeTruthy();
    await act(async () => {
      pickButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const select = container.querySelector('select')!;
    expect(select).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      nativeSetter.call(select, 'e-recent');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '배정');
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u === '/api/stories/o1')).toBe(true);
    expect(patchBodies).toContainEqual({ epic_id: 'e-recent' });
    expect(container.textContent).not.toContain('목표에 안 붙은 일이');
    expect(container.textContent).not.toContain('Orphan Story');
  });

  // 까심 QA REQUEST_CHANGES(2026-07-31) 회귀 가드 — "「다음으로」가 실패하면 «아무 말도 안
  // 한다»"가 재발하지 않는지 고정한다. 로컬 상태는 서버 200 후에만 바뀌므로(낙관적 업데이트
  // 없음) 실패 시엔 headline이 그대로여야 하고, 대신 실패 토스트가 «떠야» 한다.
  it('promote HTTP failure: shows a failure toast and leaves the story in the needs-next list (no optimistic update)', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls, [], 'fail'));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    // story #2224 AC1 후속(NextActionsStrip) — 승격 버튼은 그 목표 행을 펼쳐야 뜬다(예전
    // 「기본-포커스」 화면과 다르다, next-maker-screen.tsx 문서 참고).
    const stemRow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('E-Recent'));
    await act(async () => {
      stemRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const promoteButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '다음으로');
    await act(async () => {
      promoteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('처리에 실패했습니다');
    // headline은 그대로 "목표 3개 중 3개에" — 로컬 상태가 조용히 바뀌지 않았다.
    expect(container.textContent).toContain('목표 3개 중 3개에');
  });

  it('promote network error (rejected fetch, no .catch() before this fix would unhandled-reject): still shows a failure toast', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls, [], 'throw'));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const stemRow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('E-Recent'));
    await act(async () => {
      stemRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const promoteButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '다음으로');
    await act(async () => {
      promoteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('처리에 실패했습니다');
    expect(container.textContent).toContain('목표 3개 중 3개에');
  });

  // 까심 QA REQUEST_CHANGES(2026-07-31) 회귀 가드 — "성공 뒤에도 되돌리기 글자가 0건"이
  // 재발하지 않는지 고정한다. 되돌리기는 로컬 상태만 뒤집는 게 아니라 실제 PATCH(backlog로)를
  // 쏜다 — 원래 승격이 서버 200 후에만 반영됐던 것과 같은 원칙.
  it('promote success shows an undo toast, and clicking 되돌리기 PATCHes status=backlog and reverts the goal to needs-next', async () => {
    const calledUrls: string[] = [];
    const patchBodies: unknown[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls, patchBodies));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const stemRow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('E-Recent'));
    await act(async () => {
      stemRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const promoteButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '다음으로');
    await act(async () => {
      promoteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 승격 전 "3개 중 3개" → e-recent가 다음을 얻어 "3개 중 2개".
    expect(container.textContent).toContain('목표 3개 중 2개에');
    const undoButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '되돌리기');
    expect(undoButton).toBeTruthy();

    await act(async () => {
      undoButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(patchBodies).toContainEqual({ status: 'backlog' });
    // 되돌리기 후 e-recent가 다시 "다음이 비어 있는" 목록으로 — headline이 3으로 복귀.
    expect(container.textContent).toContain('목표 3개 중 3개에');
  });
});

// story #2545(카디르 라이브 재QA 5단계) — org 불일치 자동교정(switch-org)이 이 화면의 로드
// effect *後* 성공하면 projectId는 안 바뀌므로 예전엔 재요청 트리거가 없었다. bumpOrgSyncVersion()
// 호출 時 재요청되는지 고정한다.
describe('NextMakerScreen — org-sync 성공 後 재요청 (story #2545)', () => {
  it('bumpOrgSyncVersion() 호출 時 projectId가 그대로여도 재요청된다', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });
    const goalsCallsAfterMount = calledUrls.filter((u) => u.startsWith('/api/goals?')).length;
    expect(goalsCallsAfterMount).toBeGreaterThan(0);

    await act(async () => {
      bumpOrgSyncVersion();
      await new Promise((r) => setTimeout(r, 0));
    });

    const goalsCallsAfterBump = calledUrls.filter((u) => u.startsWith('/api/goals?')).length;
    expect(goalsCallsAfterBump).toBeGreaterThan(goalsCallsAfterMount); // 재요청 — 이전엔 안 늘었다(RED)
  });
});
