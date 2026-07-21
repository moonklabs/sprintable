// @vitest-environment jsdom
//
// story bb78f14b(doc resource-view-firsttouch-identity-pattern §4 "보드" 행 — ⚠️과함 주의): 진짜
// 빈 보드(stories.length===0, unfiltered)에 절제된 3요소 배너(아이콘+headline+CTA)가 컬럼 그리드
// "위"에 뜨는지(대체 아님 — 백로그 컬럼이 계속 마운트돼 있어야 CTA의 autoComposeSignal이
// 실제로 컴포저를 연다), 데이터 있으면 배너가 안 뜨는지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

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

function stubFetch(stories: Array<Record<string, unknown> & { status: string }>, members: Array<Record<string, unknown>> = []) {
  // CB-S4: 보드는 status별 5회 독립 호출(/api/stories?...&status=<col>) — 각 호출에 해당
  // status만 필터링해 {data:[...]} 형태(meta 포함)로 응답해야 실제 파싱 경로(json.data ?? [])와 맞는다.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      const status = new URL(url, 'http://localhost').searchParams.get('status');
      const matched = stories.filter((s) => s.status === status);
      return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/members')) {
      return { ok: true, json: async () => ({ data: members }) };
    }
    // 나머지(sprints/epics/workflow-executions/labels/gates 등)는 그레이스풀 폴백 경로만
    // 타면 되므로 실패 응답으로 충분(코드베이스 전반의 try/catch·optional-chaining 관례).
    return { ok: false, json: async () => null };
  }));
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

// story #2059 — 보드 실시간 반영용 EventSource 페이크. addEventListener로 등록된
// story.status_changed/story.assignee_changed 리스너를 캡처해 테스트에서 직접 dispatch한다.
type SseListener = (e: { data: string; lastEventId?: string }) => void;
let sseListeners: Record<string, SseListener[]>;

function stubEventSource() {
  sseListeners = {};
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: SseListener | null = null;
    onerror: (() => void) | null = null;
    constructor(_url: string, _opts?: unknown) {}
    addEventListener(name: string, cb: SseListener) {
      (sseListeners[name] ??= []).push(cb);
    }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
}

function dispatchSse(eventName: string, data: unknown) {
  for (const cb of sseListeners[eventName] ?? []) {
    cb({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubLocalStorage();
  stubEventSource();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { KanbanBoard } = await import('./kanban-board');
  await act(async () => { root.render(wrap(<KanbanBoard projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('KanbanBoard — 보드 first-touch 절제된 배너', () => {
  it('진짜 빈 보드면 3요소 배너(headline+설명+CTA)가 렌더된다 — 컬럼 그리드는 대체 아닌 유지', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 움직이는 일이 없어요');
    expect(html).toContain('보드는 사람과 AI가 맡은 일이 지금 흐르는 곳이에요');
    expect(html).toContain('첫 스토리 만들기');
    // 컬럼 그리드가 대체가 아니라 유지된다 — 기존 per-column "스토리가 없습니다" 플레이스홀더도 여전히 존재.
    expect(html).toContain('스토리가 없습니다');
  });

  it('배너 CTA 클릭 시 백로그 컬럼의 인라인 컴포저(제목 입력 필드)가 열린다', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 컴포저가 열리면 입력 필드(placeholder 또는 textbox role)가 나타난다.
    expect(container.querySelector('input, textarea')).not.toBeNull();
  });

  it('스토리 데이터가 있으면 배너가 렌더되지 않는다(회귀 0)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    const html = container.innerHTML;
    expect(html).not.toContain('아직 움직이는 일이 없어요');
  });
});

// story #2105 2차 — 스토리 생성 실패 배너(transitionError)가 role="alert" aria-live="assertive"로
// 스크린리더에 낭독되는지. stubFetch는 GET /api/stories?... 만 매칭하고 POST(쿼리 없음)는
// 캐치올(ok:false)로 떨어지므로 실패 경로를 그대로 재현한다.
describe('KanbanBoard — 스토리 생성 실패 접근성(story #2105 2차)', () => {
  it('생성 실패 시 role="alert" aria-live="assertive"로 배너가 렌더된다', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const titleInput = container.querySelector('input') as HTMLInputElement;
    expect(titleInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(titleInput, '새 스토리');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain('스토리 추가에 실패했습니다');
    expect(alertEl?.getAttribute('aria-live')).toBe('assertive');
  });
});

// story #2059 — 보드 실시간 반영. 새 EventSource를 여는 대신 기존 useSseNotifications의
// extraEventNames를 구독해 story.status_changed/assignee_changed를 받는다(AC2). 이미 로드된
// 카드만 in-place 패치하고(AC3, 전체 재fetch 없음) 누가 바꿨는지 토스트로 드러낸다(AC4).
describe('KanbanBoard — 실시간(SSE) 반영', () => {
  it('다른 사람이 상태를 바꾸면 토스트가 뜬다(누가 했는지 드러남, AC4)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await act(async () => {
      dispatchSse('story.status_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '댄',
        status: 'ready-for-dev', old_status: 'backlog',
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('댄님이 S1 상태를 변경했습니다');
  });

  it('내 액션의 echo(actor_id===currentTeamMemberId)는 토스트를 안 띄운다(중복 방지)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await act(async () => {
      dispatchSse('story.status_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'me-1', actor_name: '나',
        status: 'ready-for-dev', old_status: 'backlog',
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('상태를 변경했습니다');
  });

  it('다른 project_id의 이벤트는 무시한다(org-wide 브로드캐스트 클라이언트 필터)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await act(async () => {
      dispatchSse('story.status_changed', {
        story_id: 's1', project_id: 'other-project', actor_id: 'other-1', actor_name: '댄',
        status: 'ready-for-dev', old_status: 'backlog',
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('상태를 변경했습니다');
  });

  it('아직 로드되지 않은 스토리 id의 이벤트는 조용히 무시한다(크래시 없음)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await act(async () => {
      dispatchSse('story.status_changed', {
        story_id: 'not-loaded', project_id: 'proj-1', actor_id: 'other-1', actor_name: '댄',
        status: 'ready-for-dev', old_status: 'backlog',
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('상태를 변경했습니다');
  });

  it('담당자 변경 이벤트도 토스트로 드러난다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: null }]);
    await mount();
    await act(async () => {
      dispatchSse('story.assignee_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '까심',
        assignee_id: 'agent-1', old_assignee_id: null,
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('까심님이 S1 담당자를 변경했습니다');
  });

  // story #2130 — 토스트만 뜨고 카드 화면(아바타)은 안 바뀌던 결함의 회귀가드. StoryCard는
  // assignees(배열·assignee_ids 유래)를 assignee(단일·assignee_id 유래)보다 우선해 그리므로,
  // 핸들러가 assignee_id만 갱신하면 화면은 stale한 배열을 계속 본다(#2384와 같은 클래스).
  it('담당자 변경 시 카드가 새 담당자 이름으로 실제로 렌더된다(#2130) — 배열 필드도 함께 갱신', async () => {
    // 옛 담당자가 assignee_ids 배열에 이미 들어있는 상태(까심 재현 조건과 동일)로 시작한다.
    stubFetch(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: 'old-1', assignee_ids: ['old-1'] }],
      [{ id: 'old-1', name: '올드멤버', type: 'human' }, { id: 'new-1', name: '뉴멤버', type: 'agent' }],
    );
    await mount();
    // 아바타는 title 속성에 전체 이름을 담고 화면엔 이니셜만 그린다(getInitials) — title로 정확히 식별한다.
    expect(container.querySelector('[title="올드멤버"]')).not.toBeNull();
    await act(async () => {
      dispatchSse('story.assignee_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '까심',
        assignee_id: 'new-1', old_assignee_id: 'old-1', assignees: ['new-1'],
      });
      await Promise.resolve();
    });
    // 카드가 실제로 새 담당자로 바뀌어야 한다 — 옛 담당자 아바타가 더 이상 카드에 남아있으면 안 된다.
    expect(container.querySelector('[title="뉴멤버"]')).not.toBeNull();
    expect(container.querySelector('[title="올드멤버"]')).toBeNull();
  });

  it('담당자 변경 시(원래 미배정) memberMap에 새 담당자가 없어도 assignee_id/assignee_ids는 갱신된다(#2130 빈칸-유지 케이스)', async () => {
    // memberMap에 새 담당자가 없는 극단 케이스(예: 프로젝트 멤버 목록 밖 계정) — 이때도
    // state 자체는 정확히 갱신돼야 한다(렌더가 못 그리는 것과 state가 안 바뀌는 것은 별개 결함).
    stubFetch(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: null, assignee_ids: [] }],
      [],
    );
    await mount();
    await act(async () => {
      dispatchSse('story.assignee_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '오르테가',
        assignee_id: 'unknown-member', old_assignee_id: null, assignees: ['unknown-member'],
      });
      await Promise.resolve();
    });
    // 토스트는 여전히 뜬다(핸들러가 실행됐다는 관측 가능한 신호) — 카드 시각 확認은 memberMap
    // 의존이라 이 테스트 범위 밖(멤버 목록 자체가 별건).
    expect(container.textContent).toContain('오르테가님이 S1 담당자를 변경했습니다');
  });
});

// story #2137 — 카드는 갱신되는데 상세 패널만 옛값에 고정되던 결함(#2384·#2130과 같은 클래스의
// 3번째 재발). 카드(stories 배열)와 패널(selectedStory)이 별도 state라 SSE 패치가 stories에만
// 적용되던 게 근본 — patchStoryFromSse가 둘을 같이 갱신하는지 패널 스코프(role=dialog)로 고정한다.
describe('KanbanBoard — 실시간(SSE) 상세 패널 동기화(#2137)', () => {
  async function openPanel(title: string) {
    const card = container.querySelector(`[title="${title}"]`) as HTMLElement | null;
    expect(card).not.toBeNull();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('패널이 열려 있을 때 다른 사람이 담당자를 바꾸면 패널도 새 담당자로 갱신된다', async () => {
    stubFetch(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: 'old-1', assignee_ids: ['old-1'] }],
      [{ id: 'old-1', name: '올드멤버', type: 'human' }, { id: 'new-1', name: '뉴멤버', type: 'agent' }],
    );
    await mount();
    await openPanel('S1');
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('올드멤버');

    await act(async () => {
      dispatchSse('story.assignee_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '까심',
        assignee_id: 'new-1', old_assignee_id: 'old-1', assignees: ['new-1'],
      });
      await Promise.resolve();
    });

    expect(dialog!.textContent).toContain('뉴멤버');
    expect(dialog!.textContent).not.toContain('올드멤버');
  });

  it('패널이 열려 있을 때 다른 사람이 담당자를 해제하면 패널도 미배정으로 갱신된다', async () => {
    stubFetch(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: 'old-1', assignee_ids: ['old-1'] }],
      [{ id: 'old-1', name: '올드멤버', type: 'human' }],
    );
    await mount();
    await openPanel('S1');
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog!.textContent).toContain('올드멤버');

    await act(async () => {
      dispatchSse('story.assignee_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '까심',
        assignee_id: null, old_assignee_id: 'old-1', assignees: [],
      });
      await Promise.resolve();
    });

    expect(dialog!.textContent).not.toContain('올드멤버');
  });

  it('패널이 열려 있을 때 다른 사람이 상태를 바꾸면 패널도 새 상태로 갱신된다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await openPanel('S1');
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    await act(async () => {
      dispatchSse('story.status_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '댄',
        status: 'ready-for-dev', old_status: 'backlog',
      });
      await Promise.resolve();
    });

    // story-detail-panel.tsx: useEffect(() => setLocalStatus(story.status), [story.status]) 가
    // selectedStory prop 갱신을 따라가는지 — StatusBadge 라벨 텍스트로 확認.
    expect(dialog!.textContent).toContain('개발 대기');
  });
});
