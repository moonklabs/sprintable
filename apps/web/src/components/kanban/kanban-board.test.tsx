// @vitest-environment jsdom
//
// story bb78f14b(doc resource-view-firsttouch-identity-pattern §4 "보드" 행 — ⚠️과함 주의): 진짜
// 빈 보드(stories.length===0, unfiltered)에 절제된 3요소 배너(아이콘+headline+CTA)가 컬럼 그리드
// "위"에 뜨는지(대체 아님 — settable 첫 컬럼이 계속 마운트돼 있어야 CTA의 autoComposeSignal이
// 실제로 컴포저를 연다), 데이터 있으면 배너가 안 뜨는지 왕복 검증한다.
//
// story #2949 — 기본축이 trust인 이상 CTA는 이제 축 전환 없이 트러스트 뷰의 queued 컬럼(현재
// 보이는 축의 settable 첫 컬럼)에서 바로 컴포저를 연다(#3378의 임시 클래식 전환 브리지 제거).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

// story #4171 — 스프린트 칩 라벨 테스트가 ?sprint_id를 싣는다(기본은 빈 쿼리 — 기존 테스트 무변).
const { searchRef } = vi.hoisted(() => ({ searchRef: { current: '' } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchRef.current),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// story #3043(PO+유나 IA 확定 ⓒ, 2026-08-25) — viewMode 기본값이 이제 useIsMobile()로 갈리므로
// (예전엔 'board' 하드코딩) jsdom엔 window.matchMedia가 없어(use-mobile.ts가 그걸 직접 부른다)
// 이 파일의 기존 테스트 전부가 크래시했다. flow-client.test.tsx와 동일 패턴 — 훅 자체를
// 모킹해 desktop(false)을 기본값으로 고정, 이 스토리의 신규 describe에서만 true로 override.
let isMobileMock = false;
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_BREAKPOINT: 1024,
}));

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// story #2933 H4 qa:changes(카디르+codex, 2026-08-22) — handleTrustDragEnd(교차 신뢰컬럼
// 드래그)를 실제로 발화시켜 검증하려면 <DndContext onDragEnd={...}>의 그 콜백을 손에 쥐어야
// 한다. 이 코드베이스 전체에 dnd-kit 실 포인터 제스처 시뮬레이션 선례가 0(grep 확認) —
// useSseNotifications를 모킹해 콜백을 캡처하는 기존 관례(story-detail-panel.test.tsx)와
// 동형으로, DndContext만 부분 모킹해 onDragEnd를 캡처한다(다른 export는 실물 그대로 재사용 —
// useDroppable/useSortable 등은 실제 dnd-kit 훅이라야 카드 wiring 테스트가 의미 있음).
const { capturedDragEndHandlers } = vi.hoisted(() => ({
  capturedDragEndHandlers: [] as Array<(event: unknown) => void>,
}));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ onDragEnd, children }: { onDragEnd?: (event: unknown) => void; children?: React.ReactNode }) => {
      if (onDragEnd) capturedDragEndHandlers.push(onDragEnd);
      return children;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
// story #3759 — kanban-board.tsx는 이제 저장오류 배너를 useDashboardContext().
// bottomDockBannerSlot으로 포털한다(BottomDock 소유 dock 컬럼 실물 대신 테스트용 DOM
// 노드). `container`(createRoot 대상) 밖에 별도로 붙인다 — createRoot는 자기 container의
// 자식 전체를 소유해 렌더마다 지우므로, container 안에 미리 넣어두면 첫 렌더에 사라진다.
// 배너 관련 단언은 `bannerSlot`을 직접 쿼리한다(container 대신).
let bannerSlot: HTMLDivElement;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

// PO 긴급 fix(P0-04 기본축 trust 플립, 2026-08-22) — 실 BE는 trust_stage를 매 요청마다
// derive_trust_stage()로 항상 계산해 내려준다(backend/app/services/trust_pipeline.py, done/미지
// status 제외 None 없음). 이 축과 무관한 기존 테스트 다수가 trust_stage 없는 고정(fixture)을
// 써왔는데, 기본 뷰가 trust로 바뀌면 그 고정이 실 BE 응답과 달라 카드가 어느 컬럼에도 안 걸려
// 사라진다(storyTrustColumn: status!=='done'이면 trust_stage ?? null). 개별 테스트 50여곳을
// 일일이 고치는 대신 이 stub 자체를 실 BE 파생 규칙과 정합시킨다 — 명시적으로 trust_stage를
// 지정한 케이스(H4 테스트 등, null 명시 포함)는 그대로 존중하고 아예 안 준 경우만 채운다.
function deriveDefaultTrustStage(status: string): string | null {
  if (status === 'backlog' || status === 'ready-for-dev') return 'queued';
  if (status === 'in-progress') return 'running';
  if (status === 'in-review') return 'claimed_done';
  return null; // done/미지 status — derive_trust_stage와 동형.
}

function stubFetch(stories: Array<Record<string, unknown> & { status: string }>, members: Array<Record<string, unknown>> = []) {
  const withTrustStage = stories.map((s) => ('trust_stage' in s ? s : { ...s, trust_stage: deriveDefaultTrustStage(s.status) }));
  // CB-S4: 보드는 status별 5회 독립 호출(/api/stories?...&status=<col>) — 각 호출에 해당
  // status만 필터링해 {data:[...]} 형태(meta 포함)로 응답해야 실제 파싱 경로(json.data ?? [])와 맞는다.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      const status = new URL(url, 'http://localhost').searchParams.get('status');
      const matched = withTrustStage.filter((s) => s.status === status);
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
  bannerSlot = document.createElement('div');
  document.body.appendChild(bannerSlot);
  root = createRoot(container);
  stubLocalStorage();
  stubEventSource();
  useDashboardContextMock.mockReturnValue({
    currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human',
    bottomDockBannerSlot: bannerSlot,
  });
  capturedDragEndHandlers.length = 0;
  isMobileMock = false;
  searchRef.current = '';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  bannerSlot.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// story #3759 — kanban-board.tsx가 useToast()로 공유 Context를 구독한다. afterEach의
// vi.resetModules()가 모듈 레지스트리를 지우므로, 이 파일 최상단에서 한 번 정적 import한
// ToastProvider/ToastContainer/useToast와 kanban-board.tsx가(동적 import 뒤) 실제로 읽는
// 모듈 인스턴스가 서로 달라져(각자 다른 createContext() 결과물) Provider 밖 에러가 났다 —
// kanban-board.tsx와 «같은» 새로 뜬 모듈 인스턴스를 매 mount()마다 함께 동적 import해
// 이 파일도 그 인스턴스를 쓴다(정적 import 사본 0, 같은 자리에서 같이 새로 뜬다).
async function mount() {
  const { KanbanBoard } = await import('./kanban-board');
  const { ToastProvider, ToastContainer, useToast } = await import('@/components/ui/toast');

  function TestToastRenderer() {
    const { toasts, dismissToast } = useToast();
    return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
  }

  await act(async () => {
    root.render(wrap(
      <ToastProvider>
        <KanbanBoard projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" />
        <TestToastRenderer />
      </ToastProvider>,
    ));
  });
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
    // 컬럼 그리드가 대체가 아니라 유지된다 — 기존 per-column "스토리가 없어요" 플레이스홀더도 여전히 존재.
    expect(html).toContain('스토리가 없어요');
  });

  it('배너 CTA 클릭 시 트러스트 뷰 queued 컬럼의 인라인 컴포저(제목 입력 필드)가 열린다 — 축 전환 없음', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 컴포저가 열리면 입력 필드(placeholder 또는 textbox role)가 나타난다.
    expect(container.querySelector('input, textarea')).not.toBeNull();
    // ⭐핵심(story #2949) — 축 전환 브리지가 사라졌으니 트러스트 축 라벨(예: "입력 필요")이
    // 여전히 보여야 한다(클래식 5-status로 튕기지 않음).
    expect(container.textContent).toContain('입력 필요');
  });

  it('컴포저에서 제출하면 H4 매핑(queued→ready-for-dev)대로 status가 실린 POST가 나간다', async () => {
    const posted: Array<Record<string, unknown>> = [];
    stubFetch([]);
    const baseFetch = vi.mocked(fetch);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/stories' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        posted.push(body);
        return { ok: true, json: async () => ({ data: { id: 'new-1', ...body } }) };
      }
      return baseFetch(url, init);
    }));
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '새 스토리');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('추가'));
    expect(submitButton).not.toBeUndefined();
    await act(async () => { submitButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.['status']).toBe('ready-for-dev'); // TRUST_COLUMN_TO_STATUS.queued
    expect(posted[0]?.['title']).toBe('새 스토리');
  });

  it('배너 CTA 클릭은 축 전환을 localStorage에 저장하지 않는다(회귀 0 — 애초에 전환 자체가 없음)', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('input, textarea')).not.toBeNull(); // 임시 전환 자체는 여전히 동작.

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.resetModules();
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    stubEventSource();
    await mount();
    // CTA 클릭이 명시 선택으로 저장됐다면 여기서도 classic(5-status)일 것 — 저장 안 됐으므로
    // 기본값(trust)으로 복귀해 신뢰축 라벨이 다시 보인다.
    expect(container.textContent).toContain('입력 필요');
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
//
// ⚠️리베이스 후 전수 검증(story #2105 2차) 중 발견: 원래 이 테스트는 Enter 디스패치 뒤
// `await Promise.resolve()` 2회로 고정 대기했다 — 실제 체인(onKeyDown→submitCompose
// [fire-and-forget]→await onCreateStory→await fetch(mock)→!res.ok 분기→submitCompose의
// await 재개→setDraftTitle/setComposing)은 마이크로태스크 홉이 2회보다 많을 수 있어, 파일
// 단독 실행(부하 적음)에서는 우연히 통과하고 287파일 전체 스위트(부하 큼·이벤트루프 지터
// 증가)에서만 간헐적으로 실패하는 결과 불안정을 냈다(직접 확認 — 전체 스위트 3회 중 2회
// 실패, 파일 단독은 항상 통과). 고정 틱 대신 실제 DOM 조건이 나타날 때까지 짧게 폴링한다.
// story #3759 — 이 배너는 이제 container가 아니라 bannerSlot(BottomDock 대역 DOM 노드)으로
// 포털된다(createPortal) — 쿼리 대상도 그에 맞춰 bannerSlot으로.
async function waitForAlert(): Promise<Element | null> {
  for (let i = 0; i < 20; i++) {
    const el = bannerSlot.querySelector('[role="alert"]');
    if (el) return el;
    await act(async () => { await Promise.resolve(); });
  }
  return null;
}

// story #2154 — 두 번째 실패가 "첫 번째와 다른 DOM 노드"로 새로 안착하는 것까지 폴링한다.
// 단순히 "alert가 있다"만 보면 아직 언마운트되지 않은 1차 알림을 그대로 재포착해 오탐할 수 있다.
async function waitForFreshAlert(excludeNode: Element): Promise<Element | null> {
  for (let i = 0; i < 20; i++) {
    const el = bannerSlot.querySelector('[role="alert"]');
    if (el && el !== excludeNode) return el;
    await act(async () => { await Promise.resolve(); });
  }
  return null;
}

// story #3519(§16-7 2부, PO 確定 2026-09-05) — storyResults(보드 몸통, 주)와
// sprintsRes/epicsRes/membersRes(부수)가 미격리 Promise.all에 있어, 부수 하나가
// 네트워크단 reject하면 보드 주 데이터까지 조용히 텅 비던 결함의 회귀가드.
describe('KanbanBoard — Promise.all 부수 격리(story #3519)', () => {
  it('/api/members가 네트워크 reject해도 스토리(주 데이터)는 그대로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/stories?')) {
        const status = new URL(url, 'http://localhost').searchParams.get('status');
        const matched = status === 'backlog' ? [{ id: 's1', title: '살아남은 스토리', status: 'backlog', priority: 'medium', trust_stage: 'queued' }] : [];
        return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/members')) throw new Error('network down');
      return { ok: false, json: async () => null };
    }));
    await mount();
    expect(container.textContent).toContain('살아남은 스토리');
  });
});

// story #4171(E-MOBILE-SPEED) — 첫 화면 호출 폭포. 목록(스토리)은 카드 몸통(stories·goals·members)만
// 기다려 뜨고, 스프린트·배지용 호출(실행 요약·라인 상태·의존 그래프·라벨·라벨 연결·대기 게이트)은
// 그 뒤에 한꺼번에 병렬로 나간다(예전엔 sprints가 스켈레톤을 붙잡고 배지 6건이 순차였다).
describe('KanbanBoard — 첫 그림은 스토리만 기다린다(story #4171)', () => {
  it('스프린트·배지 호출이 아직 안 끝나도 스토리가 뜨고, 그 호출들은 동시에 나가 있다', async () => {
    const SECONDARY = ['/api/sprints', '/api/workflow-executions/story-summary', '/api/stories/workflow-line/status',
      '/api/dependencies/graph', '/api/labels', '/api/item-labels', '/api/gates?'];
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/stories?')) {
        const status = new URL(url, 'http://localhost').searchParams.get('status');
        const matched = status === 'backlog' ? [{ id: 's1', title: '먼저 뜨는 스토리', status: 'backlog', priority: 'medium', trust_stage: 'queued' }] : [];
        return Promise.resolve({ ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) });
      }
      if (SECONDARY.some((p) => url.startsWith(p))) return new Promise(() => {}); // 영원히 대기
      return Promise.resolve({ ok: false, json: async () => null });
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(container.textContent).toContain('먼저 뜨는 스토리');
    const called = (p: string) => fetchMock.mock.calls.some(([u]) => String(u).startsWith(p));
    for (const p of SECONDARY) expect(called(p), p).toBe(true);
  });
});

// story #4275(E-MOBILE-SPEED · 민 기기 실측 — 2단이 1단 마지막 응답 뒤 2~5ms에 출발해 정착 +0.53~0.74초). 1단 결과(story id)가
// 필요 없는 부수 요청은 1단과 같이 출발한다 — 스토리 목록이 아직 하나도 안 왔어도 이미 나가 있어야 한다. story id가 필요한
// 두 갈래(실행 요약 · 라인 상태)만 1단 뒤. 뮤테이션: 네 갈래를 1단 뒤로 되돌리면 첫 단언 RED · 두 갈래를 앞으로 당기면
// 둘째 단언 RED.
describe('KanbanBoard — story id가 필요 없는 부수 요청은 1단과 같이 출발한다(story #4275)', () => {
  it('스토리 목록 응답 전에 sprints · 의존 그래프 · 라벨 · 라벨 연결 · 대기 게이트가 이미 나가 있고, 실행 요약 · 라인 상태는 아직', async () => {
    const INDEPENDENT = ['/api/sprints', '/api/dependencies/graph', '/api/labels', '/api/item-labels', '/api/gates?'];
    const NEEDS_STORY_IDS = ['/api/workflow-executions/story-summary', '/api/stories/workflow-line/status'];
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/stories?')) return new Promise(() => {}); // 1단이 안 끝난다
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    const called = (p: string) => fetchMock.mock.calls.some(([u]) => String(u).startsWith(p));
    expect(called('/api/stories?')).toBe(true);
    for (const p of INDEPENDENT) expect(called(p), p).toBe(true);
    for (const p of NEEDS_STORY_IDS) expect(called(p), p).toBe(false);
  });
});

describe('KanbanBoard — 스프린트 칩 라벨이 거짓말하지 않는다(story #4171 까디르 QA a)', () => {
  function stubWithSprints(sprints: 'pending' | 'fail' | Array<{ id: string; title: string }>) {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/api/stories?')) return Promise.resolve({ ok: true, json: async () => ({ data: [], meta: { total: 0, nextCursor: null } }) });
      if (url.startsWith('/api/sprints')) {
        if (sprints === 'pending') return new Promise(() => {});
        if (sprints === 'fail') return Promise.resolve({ ok: false, json: async () => null });
        return Promise.resolve({ ok: true, json: async () => ({ data: sprints }) });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));
  }
  const b = koMessages.board;

  it('?sprint_id가 있고 sprints가 아직이면 «불러오는 중»(«전체 스프린트» 아님)', async () => {
    searchRef.current = 'sprint_id=spr-1';
    stubWithSprints('pending');
    await mount();
    expect(container.textContent).toContain(b.sprintChipLoading);
    expect(container.textContent).not.toContain(b.allSprints);
  });

  it('sprints 실패면 «선택한 스프린트»', async () => {
    searchRef.current = 'sprint_id=spr-1';
    stubWithSprints('fail');
    await mount();
    expect(container.textContent).toContain(b.sprintChipSelected);
    expect(container.textContent).not.toContain(b.allSprints);
  });

  it('sprints가 오면 그 스프린트 이름', async () => {
    searchRef.current = 'sprint_id=spr-1';
    stubWithSprints([{ id: 'spr-1', title: '9월 2주차' }]);
    await mount();
    expect(container.textContent).toContain('9월 2주차');
  });
});

describe('KanbanBoard — 늦게 온 이전 실행 결과는 버린다(story #4171 까디르 QA c)', () => {
  it('프로젝트 전환 뒤 이전 프로젝트 goals가 늦게 파싱돼도 새 goals를 덮지 않는다', async () => {
    let resolveOldGoals!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const u = new URL(url, 'http://localhost');
      const pid = u.searchParams.get('project_id');
      if (url.startsWith('/api/stories?')) {
        const data = u.searchParams.get('status') === 'backlog'
          ? [{ id: `s-${pid}`, title: `스토리 ${pid}`, status: 'backlog', priority: 'medium', trust_stage: 'queued', epic_id: 'e1' }] : [];
        return Promise.resolve({ ok: true, json: async () => ({ data, meta: { total: data.length, nextCursor: null } }) });
      }
      if (url.startsWith('/api/goals')) {
        if (pid === 'proj-old') return Promise.resolve({ ok: true, json: () => new Promise((r) => { resolveOldGoals = r; }) });
        return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'e1', title: '새 목표' }], meta: {} }) });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));
    const { KanbanBoard } = await import('./kanban-board');
    const { ToastProvider } = await import('@/components/ui/toast');
    const render = (projectId: string) => root.render(wrap(
      <ToastProvider><KanbanBoard projectId={projectId} wsSlug="ws-1" projSlug="p" /></ToastProvider>,
    ));
    await act(async () => { render('proj-old'); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { render('proj-new'); });
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(container.textContent).toContain('새 목표');
    await act(async () => { resolveOldGoals({ data: [{ id: 'e1', title: '옛 목표' }], meta: {} }); for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(container.textContent).toContain('새 목표');
    expect(container.textContent).not.toContain('옛 목표');
  });
});

describe('KanbanBoard — 카드 높이 바꾸는 배지는 한 번에(story #4171 유나 design)', () => {
  it('라벨이 먼저 와도 대기 게이트가 올 때까지 카드에 안 붙고, 마지막이 오면 함께 붙는다', async () => {
    let resolveGates!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/api/stories?')) {
        const status = new URL(url, 'http://localhost').searchParams.get('status');
        const data = status === 'backlog' ? [{ id: 's1', title: '배지 스토리', status: 'backlog', priority: 'medium', trust_stage: 'queued' }] : [];
        return Promise.resolve({ ok: true, json: async () => ({ data, meta: { total: data.length, nextCursor: null } }) });
      }
      if (url.startsWith('/api/labels')) return Promise.resolve({ ok: true, json: async () => [{ id: 'l1', name: '먼저온라벨', color: '#ff0000' }] });
      if (url.startsWith('/api/item-labels')) return Promise.resolve({ ok: true, json: async () => [{ item_id: 's1', label_id: 'l1' }] });
      if (url.startsWith('/api/gates?')) return Promise.resolve({ ok: true, json: () => new Promise((r) => { resolveGates = r; }) });
      return Promise.resolve({ ok: false, json: async () => null });
    }));
    await mount();
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(container.textContent).toContain('배지 스토리');
    expect(container.textContent).not.toContain('먼저온라벨');
    await act(async () => { resolveGates([]); for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(container.textContent).toContain('먼저온라벨');
  });
});

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
    });
    const alertEl = await waitForAlert();
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain('스토리 추가에 실패했어요');
    expect(alertEl?.getAttribute('aria-live')).toBe('assertive');
    // story 3466 후속(무효 유틸 4곳) — 이 배너가 no-op text-destructive-foreground
    // 대신 실 렌더 색을 갖는지.
    expect(alertEl?.className).toContain('text-white');
    expect(alertEl?.className).toContain('dark:text-proof-bg');
    expect(alertEl?.className).not.toContain('text-destructive-foreground');
  });

  // story #2154 — transitionError는 4초 후 자동 setTransitionError(null)로만 해소되고, 재시도
  // 直前에 명시적으로 null 리셋하지 않는다. 4초 내 동일 사유가 재발하면 같은 DOM 노드가 재사용돼
  // 재낭독이 안 될 수 있던 것을 bumpTransitionErrorNonce()+key로 구조적으로 막았다 — 연속 두 번
  // 동일 실패 시 서로 다른 DOM 노드임을 고정한다.
  //
  // ⚠️테스트 작성 중 발견(별건 — 이 스토리 스코프 아님, 그대로 기록): handleCreateStory의 실패
  // 분기는 throw 없이 return만 해 submitCompose가 실패를 성공으로 오인, 컴포저를 닫아버린다
  // (입력했던 제목이 실패해도 사라짐 — 화면에 보이는 사용자도 잃는 정보다). 그래서 "같은 컴포저에
  // 연속 제출"이 UI상 불가능해 매 시도 前 CTA를 다시 클릭해 컴포저를 재오픈한다.
  it('생성 실패가 연속으로 나도(4초 내 동일 사유) 매번 새 DOM 노드로 안착한다', async () => {
    stubFetch([]);
    await mount();

    async function openComposeAndSubmit(title: string) {
      const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
      await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const titleInput = container.querySelector('input') as HTMLInputElement;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(titleInput, title);
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
    }

    await openComposeAndSubmit('첫 시도');
    const first = await waitForAlert();
    expect(first).not.toBeNull();

    await openComposeAndSubmit('첫 시도');
    const second = await waitForFreshAlert(first!);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  // story #3007(로드맵 P2·PR-E, L1) — 토스트성 에러배너는 floating이라 --elev-overlay.
  it('생성 실패 배너가 shadow-[var(--elev-overlay)]를 쓰고 shadow-md는 안 쓴다', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const titleInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(titleInput, '새 스토리');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    const alertEl = await waitForAlert();
    expect(alertEl?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(alertEl?.className).not.toMatch(/(^|\s)shadow-md(\s|$)/);
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
    expect(container.textContent).toContain('댄님이 S1 상태를 변경했어요');
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
    expect(container.textContent).not.toContain('상태를 변경했어요');
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
    expect(container.textContent).not.toContain('상태를 변경했어요');
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
    expect(container.textContent).not.toContain('상태를 변경했어요');
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
    expect(container.textContent).toContain('까심님이 S1 담당자를 변경했어요');
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
    expect(container.textContent).toContain('오르테가님이 S1 담당자를 변경했어요');
  });

  // story #2172 AC5 — BE(#2476)는 이미 story.position_changed를 발행하고 있었으나 FE 구독이
  // 없어 "프레임은 나가는데 아무도 안 받는" 죽은 경로였다(라이브 실측으로 확認, dev). 컬럼 렌더가
  // position으로 정렬하므로(storiesByColumn) position만 patch하면 재정렬은 그 정렬 로직이
  // 그대로 이어받는다 — 이 테스트는 그 재정렬이 실제로 일어나는지 카드 DOM 순서로 고정한다.
  it('순서 변경 이벤트도 토스트로 드러난다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', position: 1000 }]);
    await mount();
    await act(async () => {
      dispatchSse('story.position_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '유나',
        position: 500, old_position: 1000,
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('유나님이 S1 순서를 변경했어요');
  });

  it('순서 변경 시 카드가 같은 컬럼 안에서 실제로 재배치된다(#2172 AC5②)', async () => {
    // S1이 S2보다 뒤(position 큰 값)로 시작 — 이벤트로 S1이 S2보다 앞서게 만든다.
    stubFetch([
      { id: 's1', title: 'S1', status: 'backlog', priority: 'medium', position: 2000 },
      { id: 's2', title: 'S2', status: 'backlog', priority: 'medium', position: 1000 },
    ]);
    await mount();
    // ⚠️컨테이너 전체 textContent로 순서를 재면 ToastContainer가 담는 토스트 문구(스토리 제목을
    // 그대로 포함)에 오염된다 — 오늘 라이브 계측에서 한 번 걸린 그 함정과 동형이라, 카드
    // 자체만(dnd-kit useSortable이 부여하는 aria-roledescription="sortable") 스코프를 좁힌다.
    function cardOrder(): string[] {
      return Array.from(container.querySelectorAll('[aria-roledescription="sortable"]'))
        .map((el) => (el.textContent!.includes('S1') ? 'S1' : el.textContent!.includes('S2') ? 'S2' : '?'));
    }
    expect(cardOrder()).toEqual(['S2', 'S1']); // 시작 상태: S2(1000)가 S1(2000)보다 먼저

    await act(async () => {
      dispatchSse('story.position_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '유나',
        position: 500, old_position: 2000,
      });
      await Promise.resolve();
    });

    expect(cardOrder()).toEqual(['S1', 'S2']); // S1이 500으로 내려와 S2(1000)보다 앞으로 옴
  });

  it('position 값이 실제로 안 바뀐 순서 이벤트는 무시한다(음성대조 — 과다 patch/토스트 방지)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', position: 1000 }]);
    await mount();
    await act(async () => {
      dispatchSse('story.position_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'other-1', actor_name: '유나',
        position: 1000, old_position: 1000, // 동일값 — 실질 변경 없음
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('순서를 변경했어요');
  });

  it('내 액션의 echo(actor_id===currentTeamMemberId)는 순서 변경 토스트도 안 띄운다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', position: 1000 }]);
    await mount();
    await act(async () => {
      dispatchSse('story.position_changed', {
        story_id: 's1', project_id: 'proj-1', actor_id: 'me-1', actor_name: '나',
        position: 500, old_position: 1000,
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('순서를 변경했어요');
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

// story #3588 — StoryDetailPanel이 selectedStory prop만 바뀌고 리마운트 안 되면(kanban-board.tsx/
// epic-swimlane-board.tsx 둘 다 <StoryDetailPanel key 없이> 소비) editingTitle 등 로컬 state가
// A→B 카드 전환 뒤에도 살아남는다. key={story.id}로 통짜 리마운트해 전부 초기화되는지 고정한다.
describe('KanbanBoard — 상세 패널 story 전환 시 로컬 state 리셋(#3588)', () => {
  async function openPanel(title: string) {
    const card = container.querySelector(`[title="${title}"]`) as HTMLElement | null;
    expect(card).not.toBeNull();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('A에서 제목 편집모드 진입 후 B로 전환하면 편집모드가 자동으로 닫힌다', async () => {
    stubFetch([
      { id: 's1', title: 'S1', status: 'backlog', priority: 'medium' },
      { id: 's2', title: 'S2', status: 'backlog', priority: 'medium' },
    ]);
    await mount();
    await openPanel('S1');
    const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog()).not.toBeNull();

    const titleButton = dialog().querySelector('h2')!.closest('button') as HTMLElement;
    await act(async () => {
      titleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(dialog().querySelector('[data-testid="story-title-input"]')).not.toBeNull();

    await openPanel('S2');

    expect(dialog().querySelector('[data-testid="story-title-input"]')).toBeNull();
    expect(dialog().textContent).toContain('S2');
  });
});

// story #3704(유나 발견+카디르 비블로커, #4054 재리뷰 中) — handleStoryClick이 진입 시
// storyTasks 자신을 안 비우고, A→B 연타에서 늦게 온 A 응답이 B의 tasks/nextCursor/totalCount를
// 덮을 수 있었다(형제 epic-swimlane-board.tsx엔 cancelled 가드가 있는데 kanban-board만 없었다).
function deferredTaskResponse() {
  let resolve!: (v: { ok: boolean; json: () => Promise<unknown> }) => void;
  const promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((res) => { resolve = res; });
  return { promise, resolve };
}

function taskOk(rows: Array<{ id: string; title: string; status: string }>, totalCount: number, nextCursor: string | null = null) {
  return { ok: true, json: async () => ({ data: rows, meta: { nextCursor, totalCount } }) };
}

function stubFetchWithTasks(
  stories: Array<Record<string, unknown> & { status: string }>,
  taskHandlers: Record<string, (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>,
) {
  const withTrustStage = stories.map((s) => ('trust_stage' in s ? s : { ...s, trust_stage: deriveDefaultTrustStage(s.status) }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      const status = new URL(url, 'http://localhost').searchParams.get('status');
      const matched = withTrustStage.filter((s) => s.status === status);
      return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/members')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/tasks?story_id=')) {
      const storyId = new URL(url, 'http://localhost').searchParams.get('story_id')!;
      const handler = taskHandlers[storyId];
      if (handler) return handler(url);
      return taskOk([], 0);
    }
    return { ok: false, json: async () => null };
  }));
}

describe('KanbanBoard — handleStoryClick storyTasks 리셋·취소 가드(story #3704)', () => {
  async function clickStory(title: string) {
    const card = container.querySelector(`[title="${title}"]`) as HTMLElement | null;
    expect(card).not.toBeNull();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('A 로드 後 B 클릭 응답 500 — B 패널에 A의 태스크가 한 건도 안 남는다(blocker①)', async () => {
    stubFetchWithTasks(
      [
        { id: 's1', title: 'S1', status: 'backlog', priority: 'medium' },
        { id: 's2', title: 'S2', status: 'backlog', priority: 'medium' },
      ],
      {
        s1: () => Promise.resolve(taskOk([{ id: 't1', title: 'A태스크', status: 'todo' }], 1)),
        s2: () => Promise.resolve({ ok: false, json: async () => null }),
      },
    );
    await mount();
    await clickStory('S1');
    const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog().textContent).toContain('A태스크');

    await clickStory('S2');
    expect(dialog().textContent).not.toContain('A태스크'); // 옛 스토리 태스크가 남으면 안 됨.
    expect(dialog().textContent).toContain(koMessages.board.noTasks); // 정직한 빈 상태.
  });

  it('A 클릭→B 클릭, A 응답이 B보다 늦게 도착 — 패널은 끝까지 B 값이다(blocker②)', async () => {
    const aResponse = deferredTaskResponse();
    stubFetchWithTasks(
      [
        { id: 's1', title: 'S1', status: 'backlog', priority: 'medium' },
        { id: 's2', title: 'S2', status: 'backlog', priority: 'medium' },
      ],
      {
        s1: () => aResponse.promise,
        s2: () => Promise.resolve(taskOk([{ id: 't2', title: 'B태스크', status: 'todo' }], 1)),
      },
    );
    await mount();
    await clickStory('S1'); // A 요청 발화 — 아직 응답 안 옴(deferred).
    await clickStory('S2'); // B 요청 발화+즉시 응답 — 패널은 B 값으로 정착.

    const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog().textContent).toContain('B태스크');

    await act(async () => { // 이제야 A의 늦은 응답이 도착 — 요청 순번이 안 맞아 버려져야 한다.
      aResponse.resolve(taskOk([{ id: 't1', title: 'A태스크', status: 'todo' }], 1));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('B태스크'); // 여전히 B.
    expect(dialog().textContent).not.toContain('A태스크'); // 늦게 온 A가 덮으면 안 됨.
  });

  // story #3704 후속(카디르 재-QA, PR#4055 2026-09-09) — 위 requestId 대조가 fetch 직후
  // (res.json() 파싱 前)에만 있어, res.json() 자체가 비동기라 그 파싱 사이에 새 클릭이
  // 순번을 올릴 수 있다 — 파싱 뒤(상태 반영 직전) 재대조가 없으면 옛 결과가 새 클릭보다
  // 늦게 커밋된다.
  it('res.json() 파싱 사이 새 클릭이 순번을 올리면 늦게 파싱된 A 결과를 커밋하지 않는다(blocker②-2)', async () => {
    let resolveABody!: (v: unknown) => void;
    const aBody = new Promise((res) => { resolveABody = res; });
    stubFetchWithTasks(
      [
        { id: 's1', title: 'S1', status: 'backlog', priority: 'medium' },
        { id: 's2', title: 'S2', status: 'backlog', priority: 'medium' },
      ],
      {
        s1: () => Promise.resolve({ ok: true, json: () => aBody }), // fetch 레벨은 즉시 도착 — json() 파싱만 지연.
        s2: () => Promise.resolve(taskOk([{ id: 't2', title: 'B태스크', status: 'todo' }], 1)),
      },
    );
    await mount();
    await clickStory('S1'); // A의 fetch 레벨 대조는 이미 통과 — 지금은 res.json() 파싱 대기 중.

    await clickStory('S2'); // B로 이동 — requestId가 여기서 올라간다.
    const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog().textContent).toContain('B태스크');

    await act(async () => { // A의 json() 파싱이 이제야 끝난다 — 파싱 뒤 재대조가 없으면 여기서 B를 덮는다.
      resolveABody({ data: [{ id: 't1', title: 'A태스크', status: 'todo' }], meta: { nextCursor: null, totalCount: 1 } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('B태스크');
    expect(dialog().textContent).not.toContain('A태스크');
  });

  // story #3704 후속(유나 design CHANGES, PR#4055 2026-09-09) — onLoadMoreTasks(「더 보기」)는
  // handleStoryClick과 별개 자리라 이 가드가 안 걸렸다. A에서 「더 보기」 pending 중
  // onNavigate(패널 안 이동, 패널은 안 닫힘)로 B로 넘어가면 A의 page2 응답이 B 목록에
  // append되고 totalCount까지 A 것으로 덮일 수 있었다.
  it('A 「더 보기」 pending 중 B로 이동 — 늦게 온 A page2가 B 목록/총계를 덮지 않는다(blocker③)', async () => {
    let resolveAPage2!: (v: { ok: boolean; json: () => Promise<unknown> }) => void;
    const aPage2 = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((res) => { resolveAPage2 = res; });
    stubFetchWithTasks(
      [
        { id: 's1', title: 'S1', status: 'backlog', priority: 'medium' },
        { id: 's2', title: 'S2', status: 'backlog', priority: 'medium' },
      ],
      {
        s1: (url: string) => (url.includes('cursor=')
          ? aPage2 // 「더 보기」(page2) — deferred.
          : Promise.resolve(taskOk([{ id: 't1', title: 'A1', status: 'todo' }], 5, 'c1'))), // page1, nextCursor=c1.
        s2: () => Promise.resolve(taskOk([{ id: 't2', title: 'B태스크', status: 'todo' }], 1)),
      },
    );
    await mount();
    await clickStory('S1');
    const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog().textContent).toContain('A1');

    const loadMoreBtn = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent === koMessages.board.loadMore) as HTMLElement | undefined;
    expect(loadMoreBtn()).toBeDefined();
    await act(async () => {
      loadMoreBtn()!.click();
      await Promise.resolve();
      await Promise.resolve();
    }); // page2 fetch 발화 — 아직 응답 안 옴(deferred).

    await clickStory('S2'); // B로 이동 — requestId가 올라간다.
    expect(dialog().textContent).toContain('B태스크');

    await act(async () => { // 이제야 A의 page2가 도착 — B 패널을 덮으면 안 된다.
      resolveAPage2(taskOk([{ id: 't1b', title: 'A2', status: 'todo' }], 5, null));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('B태스크');
    expect(dialog().textContent).not.toContain('A2'); // A page2가 B 목록에 섞이면 안 됨.
    expect(dialog().textContent).not.toContain('태스크 (5)'); // A의 총계(5)가 B 총계(1)를 덮으면 안 됨.
  });

  // story #3709(FE 완전성-정직, 3704 후속) — 응답 前(조회 中)엔 tasks=[]·totalCount=null인데
  // 로딩 신호가 없으면 StoryDetailPanel이 이걸 "정말 0개"로 오단정했다.
  it('응답 前(조회 中)엔 "태스크가 없어요" 대신 "불러오는 중"이 뜬다', async () => {
    const aResponse = deferredTaskResponse();
    stubFetchWithTasks(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }],
      { s1: () => aResponse.promise },
    );
    await mount();
    await clickStory('S1'); // 응답 아직 안 옴(deferred) — 지금이 "조회 中" 창.

    const dialog = () => container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog().textContent).not.toContain(koMessages.board.noTasks);
    expect(dialog().textContent).toContain(koMessages.board.loading);

    await act(async () => { // 응답 도착 — 진짜 0건이면 이제야 정당하게 "없습니다".
      aResponse.resolve(taskOk([], 0));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain(koMessages.board.noTasks);
    expect(dialog().textContent).not.toContain(koMessages.board.loading);
  });
});

// story #2104 — BE stories.py:1056(human-only 영구삭제 403)를 FE가 미리 안 보고 에이전트
// 계정에도 삭제 트리거를 무조건 열었다(#2091/#2103과 같은 결함). 양방향 고정 — human까지
// 잠그면 정당한 삭제가 봉쇄되는 더 큰 사고다(승격 위험목록의 잔여 미검증 칸 해소).
describe('StoryDetailPanel — 영구삭제 트리거 authz(story #2104)', () => {
  async function openPanel(title: string) {
    const card = container.querySelector(`[title="${title}"]`) as HTMLElement | null;
    expect(card).not.toBeNull();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('human이면 스토리 영구삭제 트리거가 렌더된다(정당한 사용자는 막히면 안 됨)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await openPanel('S1');
    expect(container.querySelector('[role="dialog"] button[aria-label="스토리 삭제"]')).not.toBeNull();
  });

  it('agent면 스토리 영구삭제 트리거가 안 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({
      currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'agent',
      bottomDockBannerSlot: bannerSlot,
    });
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    await openPanel('S1');
    expect(container.querySelector('[role="dialog"] button[aria-label="스토리 삭제"]')).toBeNull();
  });
});

// story #2545(카디르 라이브 재QA 5단계) — org 불일치 자동교정(switch-org)이 fetchData *後*
// 성공하면 projectId는 안 바뀌므로 예전엔 재요청 트리거가 없었다(hypothesis-earth-layer 등
// 다른 컴포넌트와 동형 결함 — 여기 5번째 자리로 확認됨). bumpOrgSyncVersion()이 보드
// fetchData를 재요청시키는지 고정한다.
describe('KanbanBoard — org-sync 성공 後 재요청 (story #2545)', () => {
  it('bumpOrgSyncVersion() 호출 時 projectId가 그대로여도 fetchData가 재요청된다', async () => {
    const { bumpOrgSyncVersion } = await import('@/lib/project-context-client');
    let storiesCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/stories?')) {
        storiesCalls += 1;
        return { ok: true, json: async () => ({ data: [], meta: { total: 0, nextCursor: null } }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/members')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await mount();
    const callsAfterMount = storiesCalls;
    expect(callsAfterMount).toBeGreaterThan(0); // CB-S4: status별 5회 독립 호출

    await act(async () => {
      bumpOrgSyncVersion();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(storiesCalls).toBeGreaterThan(callsAfterMount); // 재요청 — 이전엔 안 늘었다(RED)
  });
});

// story #2187 — 라이브 QA 임시 카드([TEMP-QA] 등)는 삭제가 휴먼 전용이라 만든 쪽이 못 치운다.
// PO가 is_excluded=true로 마킹해도 보드가 그 필드를 안 보면 화면엔 그대로 남아 "«남은 일»을
// 과장"한다(#2187 관측 그대로) — 화면이 실제로 이 플래그를 존중해 숨기는지 회귀가드한다.
describe('KanbanBoard — is_excluded 카드 숨김(story #2187)', () => {
  it('is_excluded=true인 카드는 컬럼에 렌더되지 않는다 — 형제 카드(제외 아님)는 그대로 보인다', async () => {
    stubFetch([
      { id: 's-hidden', title: '[TEMP-QA] 검증용 임시 카드', status: 'backlog', priority: 'medium', is_excluded: true },
      { id: 's-visible', title: '진짜 백로그 항목', status: 'backlog', priority: 'medium', is_excluded: false },
    ]);
    await mount();
    const html = container.innerHTML;
    expect(html).not.toContain('[TEMP-QA] 검증용 임시 카드');
    expect(html).toContain('진짜 백로그 항목');
  });

  it('is_excluded 카드가 있으면 "N건 숨김" 배지가 정확한 수로 뜬다 — 없으면 배지 자체가 없다', async () => {
    stubFetch([
      { id: 's-hidden-1', title: '[TEMP-QA] 1', status: 'backlog', priority: 'medium', is_excluded: true },
      { id: 's-hidden-2', title: '[TEMP-QA] 2', status: 'ready-for-dev', priority: 'medium', is_excluded: true },
      { id: 's-visible', title: '진짜 항목', status: 'backlog', priority: 'medium', is_excluded: false },
    ]);
    await mount();
    expect(container.textContent).toContain('2건 숨김');
  });

  it('is_excluded 카드가 하나도 없으면 "숨김" 배지가 렌더되지 않는다(과잉 배지 금지)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', is_excluded: false }]);
    await mount();
    expect(container.textContent).not.toContain('숨김');
  });
});

// story #2933 H4(P0-H, v4 아티팩트 e65f1016) — 6단계 신뢰축+완료 7컬럼 뷰. SSOT=story.trust_stage
// (H1) — FE 재계산 0. 판별: queued가 backlog+ready-for-dev를 흡수·done은 status==='done' 별도
// 대조로 파이프라인 밖 7번째 컬럼·파생 3컬럼(needs_input/verified/merge_ready)은 카드가
// 드래그 wiring 자체를 잃는다(locked → useSortable disabled → aria-roledescription 미부착).
describe('KanbanBoard — 6단계 신뢰축 뷰(story #2933 H4)', () => {
  async function toggleToTrustAxis() {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    expect(btn, '신뢰축 토글 버튼을 못 찾음').toBeDefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  // PO 긴급 fix(선생님 지적, 2026-08-22) — 방향서 P0-04 원문 «기본 상태는 신뢰 파이프라인으로»를
  // #2933 done 선언 당시 전원(오르테가·QA·design)이 놓쳐 기본값이 거꾸로 'status'였다(실측
  // 결함). 이 테스트는 원래 그 잘못된 기본값을 그린으로 고정했던 자리 — 스펙대로 뒤집는다.
  it('기본은 6단계 신뢰축 뷰(P0-04 스펙) — localStorage 미설정 시 5단계 클래식 라벨이 안 보인다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    await mount();
    expect(container.textContent).toContain('입력 필요');
    expect(container.textContent).toContain('머지 준비');
    expect(container.textContent).not.toContain('개발 대기');
  });

  it('사용자가 명시적으로 5단계 클래식을 선택하면(localStorage) 기본값 뒤집기와 무관하게 존중된다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    await mount();
    const classicBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '5단계 클래식');
    expect(classicBtn, '클래식 토글 버튼을 못 찾음').toBeDefined();
    await act(async () => { classicBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).not.toContain('입력 필요');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.resetModules();
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    stubEventSource();
    await mount();
    // 재마운트 후에도 명시 선택('status')이 새 기본값('trust')을 덮어쓰지 않고 유지된다.
    expect(container.textContent).not.toContain('입력 필요');
  });

  it('토글 클릭 시 7컬럼(대기/실행 중/입력 필요/주장 완료/검증·잔존/머지 준비/완료) 전부 렌더된다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    await mount();
    await toggleToTrustAxis();
    for (const label of ['대기', '실행 중', '입력 필요', '주장 완료', '검증·잔존', '머지 준비', '완료']) {
      expect(container.textContent, `"${label}" 컬럼 라벨 부재`).toContain(label);
    }
  });

  it('queued가 backlog+ready-for-dev를 흡수한다 — 서로 다른 status의 두 카드가 같은 "대기" 컬럼에 함께 뜬다', async () => {
    stubFetch([
      { id: 's-backlog', title: '백로그카드', status: 'backlog', priority: 'medium', trust_stage: 'queued' },
      { id: 's-ready', title: '개발대기카드', status: 'ready-for-dev', priority: 'medium', trust_stage: 'queued' },
    ]);
    await mount();
    await toggleToTrustAxis();
    expect(container.textContent).toContain('백로그카드');
    expect(container.textContent).toContain('개발대기카드');
  });

  it('trust_stage="needs_input" 카드는 "입력 필요" 컬럼에 뜨고 드래그 wiring이 없다(locked)', async () => {
    stubFetch([
      { id: 's-locked', title: '잠긴카드', status: 'in-progress', priority: 'medium', trust_stage: 'needs_input' },
    ]);
    await mount();
    await toggleToTrustAxis();
    expect(container.textContent).toContain('잠긴카드');
    // locked 카드는 aria-roledescription="sortable"이 안 붙는다(useSortable disabled).
    const sortableCards = Array.from(container.querySelectorAll('[aria-roledescription="sortable"]'));
    const lockedCardIsSortable = sortableCards.some((el) => el.textContent?.includes('잠긴카드'));
    expect(lockedCardIsSortable).toBe(false);
  });

  it('trust_stage=null이어도 status="in-progress"(running, settable)면 정상적으로 드래그 wiring이 붙는다', async () => {
    stubFetch([
      { id: 's-running', title: '실행중카드', status: 'in-progress', priority: 'medium', trust_stage: 'running' },
    ]);
    await mount();
    await toggleToTrustAxis();
    const sortableCards = Array.from(container.querySelectorAll('[aria-roledescription="sortable"]'));
    const runningCardIsSortable = sortableCards.some((el) => el.textContent?.includes('실행중카드'));
    expect(runningCardIsSortable).toBe(true);
  });

  it('status="done"(trust_stage=null·파이프라인 밖)이면 "완료" 컬럼에 뜬다', async () => {
    stubFetch([
      { id: 's-done', title: '완료카드', status: 'done', priority: 'medium', trust_stage: null },
    ]);
    await mount();
    await toggleToTrustAxis();
    expect(container.textContent).toContain('완료카드');
  });

  it('축 선택이 localStorage에 저장되고 재마운트 후에도 유지된다', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    await mount();
    await toggleToTrustAxis();
    expect(container.textContent).toContain('입력 필요');

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.resetModules();
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }]);
    stubEventSource();
    await mount();
    expect(container.textContent).toContain('입력 필요'); // 재마운트 후에도 신뢰축 뷰 유지
  });

  // ⚠️QA changes(PR#3366, 카디르+codex, 2026-08-22, HIGH) — 교차 신뢰컬럼 드래그의 낙관 갱신이
  // status+position만 바꾸고 trust_stage는 스프레드로 구값 잔존 — queued→running 이동은 카드가
  // 옛 컬럼(queued)에 남고, done 카드를 다른 컬럼으로 옮기면 trust_stage=null 유지로 카드가
  // 보드에서 실종된다. 처방: bulk PATCH 응답(BE가 이제 _attach_trust_stage로 채워 돌려줌)의
  // trust_stage를 응답 도착 시점에 병합. 두 케이스를 각각 재현한다.
  describe('교차 신뢰컬럼 드래그 — trust_stage 병합(PO 처방)', () => {
    // "카드 텍스트가 문서 어딘가에 있다"만으론 "옛 컬럼에 계속 남아있어도" 통과하는 동어반복
    // (실측 확認 — 이 헬퍼 없이 첫 버전을 프로덕션 fix 제거 상태로 재실행하면 queued→running
    // 케이스가 거짓 green이었다). 컬럼별 헤더 라벨로 그 컬럼의 DOM 서브트리를 좁혀 카드가
    // «그 컬럼 안에» 있는지까지 스코프한다.
    function columnTextContaining(label: string): string {
      const columns = [...container.querySelectorAll('[class*="w-\\[280px\\]"]')] as HTMLElement[];
      const col = columns.find((el) => el.querySelector('h3')?.textContent?.trim().startsWith(label));
      return col?.textContent ?? '';
    }

    function stubFetchWithBulkPatch(
      stories: Array<Record<string, unknown> & { status: string }>,
      bulkResponseTrustStage: string | null,
    ) {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (typeof url === 'string' && url.startsWith('/api/stories?')) {
          const status = new URL(url, 'http://localhost').searchParams.get('status');
          const matched = stories.filter((s) => s.status === status);
          return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
        }
        if (typeof url === 'string' && url.startsWith('/api/members')) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        if (typeof url === 'string' && url === '/api/stories/bulk' && init?.method === 'PATCH') {
          const body = JSON.parse(init.body ?? '{}') as { items: { id: string; status: string }[] };
          const item = body.items[0];
          return {
            ok: true,
            json: async () => ({
              data: [{ id: item.id, status: item.status, trust_stage: bulkResponseTrustStage, violation: null }],
            }),
          };
        }
        return { ok: false, json: async () => null };
      }));
    }

    it('queued→running 드래그 — bulk 응답 도착 後 trust_stage가 running으로 갱신돼 카드가 "실행 중" 컬럼으로 실제로 옮겨간다', async () => {
      stubFetchWithBulkPatch(
        [{ id: 's-queued', title: '대기카드', status: 'ready-for-dev', priority: 'medium', trust_stage: 'queued' }],
        'running',
      );
      await mount();
      await toggleToTrustAxis();
      expect(container.textContent).toContain('대기카드');

      const handler = capturedDragEndHandlers.at(-1);
      expect(handler, 'handleTrustDragEnd를 캡처 못 함').toBeDefined();
      await act(async () => {
        handler!({ active: { id: 's-queued' }, over: { id: 'running' } });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });

      // 컬럼별로 스코프 — "문서 어딘가엔 있다"만으론 "옛 컬럼에 계속 남아있어도" 통과하는
      // 동어반복이 된다(실측 확認 — 프로덕션 fix 제거 상태로 재실행하면 이 assertion 없이는
      // 거짓 green이었다). 병합 後엔 "대기" 컬럼에서 빠지고 "실행 중" 컬럼으로 실제로 옮겨간다.
      expect(columnTextContaining('대기')).not.toContain('대기카드');
      expect(columnTextContaining('실행 중')).toContain('대기카드');
    });

    it('done 카드를 다른 컬럼으로 드래그 — bulk 응답의 trust_stage(null 아닌 새 값)가 반영돼 카드가 보드에서 실종되지 않는다', async () => {
      stubFetchWithBulkPatch(
        [{ id: 's-done', title: '완료복귀카드', status: 'done', priority: 'medium', trust_stage: null }],
        'running',
      );
      await mount();
      await toggleToTrustAxis();
      expect(container.textContent).toContain('완료복귀카드');

      const handler = capturedDragEndHandlers.at(-1);
      expect(handler, 'handleTrustDragEnd를 캡처 못 함').toBeDefined();
      await act(async () => {
        handler!({ active: { id: 's-done' }, over: { id: 'running' } });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });

      // 처방 前(trust_stage 병합 없음)이었다면 status='in-progress'+trust_stage=null(구값
      // 잔존)이 돼 storyTrustColumn이 null을 반환해 카드가 어느 컬럼에도 안 걸려 사라졌을
      // 것 — 지금은 bulk 응답의 새 trust_stage('running')가 병합돼 여전히 렌더된다.
      expect(container.textContent).toContain('완료복귀카드');
    });
  });

  // story #3638(유나 §8·«분기 안에서 일부만 알리는» 눈멂 ③) — handleTrustDragEnd의
  // !res.ok 분기가 FORBIDDEN만 말하고 그 외 실 실패(500 등)는 롤백만 하고 조용했다.
  describe('트러스트축 드래그 — FORBIDDEN 아닌 실패도 알린다(story #3638)', () => {
    it('500 응답이면 storyMoveFailed 토스트가 뜬다(구 조용한 롤백)', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.startsWith('/api/stories?')) {
          const status = new URL(url, 'http://localhost').searchParams.get('status');
          const matched = status === 'ready-for-dev'
            ? [{ id: 's-queued', title: '대기카드', status: 'ready-for-dev', priority: 'medium', trust_stage: 'queued' }]
            : [];
          return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
        }
        if (typeof url === 'string' && url.startsWith('/api/members')) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        if (typeof url === 'string' && url === '/api/stories/bulk') {
          return { ok: false, json: async () => ({ error: { code: 'INTERNAL_ERROR' } }) };
        }
        return { ok: false, json: async () => null };
      }));
      await mount();
      await toggleToTrustAxis();

      const handler = capturedDragEndHandlers.at(-1);
      expect(handler, 'handleTrustDragEnd를 캡처 못 함').toBeDefined();
      await act(async () => {
        handler!({ active: { id: 's-queued' }, over: { id: 'running' } });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });

      expect(container.textContent).toContain('스토리 이동에 실패했어요');
    });
  });
});

// story #3043(PO+유나 IA 확定 ⓒ, 2026-08-25) — viewMode('board'|'list')가 예전엔 뷰포트 무관
// 'board'로 하드코딩돼 있었다(유나 실측: flow-client의 view='list' 세그로 진입해도 여기서
// 다시 'board'로 떨어져 3.55배 가로 overflow 재발 — 이름이 같은 두 「board/list」 개념 충돌).
// story #3638(유나 §8 kanban-board.tsx:929/:987, PO 확定 착수분) — 5단계 클래식 드래그
// (handleDragEnd)도 트러스트축 형제와 동일 병(FORBIDDEN만 말하고 나머지는 조용)을 앓는다.
describe('KanbanBoard — 5단계 클래식 드래그, FORBIDDEN 아닌 실패도 알린다(story #3638)', () => {
  it('bulk PATCH 500이면 storyMoveFailed 토스트가 뜬다(구 조용한 롤백)', async () => {
    stubFetch([{ id: 's-classic', title: '클래식카드', status: 'backlog', priority: 'medium' }]);
    await mount();
    // 기본은 6단계 신뢰축(P0-04) — 5단계 클래식으로 명시 전환해야 handleDragEnd가 걸린다.
    const classicBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '5단계 클래식');
    await act(async () => { classicBtn!.click(); });
    expect(container.textContent).toContain('클래식카드');

    const handler = capturedDragEndHandlers.at(-1);
    expect(handler, 'handleDragEnd를 캡처 못 함').toBeDefined();
    await act(async () => {
      handler!({ active: { id: 's-classic' }, over: { id: 'in-progress' } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // 기본 stubFetch는 /api/stories/bulk를 명시 처리 안 해 그레이스풀 { ok: false }로
    // 떨어진다(주석 그대로) — 이 스위트의 다른 테스트들에는 무해했지만(드래그를 직접
    // 발화한 테스트가 이제껏 0건), 이 테스트에선 그 자체가 "실 실패" 재현이다.
    expect(container.textContent).toContain('스토리 이동에 실패했어요');
  });
});

describe('KanbanBoard — story #3043 <lg 기본값=list(칸반 다열은 opt-in)', () => {
  it('모바일(isMobile=true)이면 기본값이 list다 — board 다열 컬럼이 아니라 KanbanListView가 뜬다', async () => {
    isMobileMock = true;
    stubFetch([{ id: 's-mobile', title: '모바일카드', status: 'backlog', priority: 'medium' }]);
    await mount();

    // board 뷰 전용 placeholder("스토리가 없어요", 빈 컬럼마다 반복)는 list 뷰엔 없다 —
    // list 뷰는 상태별 그룹 헤더(카운트 배지)로만 존재를 표현한다.
    expect(container.textContent).not.toContain('스토리가 없어요');
    expect(container.textContent).toContain('모바일카드');
  });

  it('데스크톱(isMobile=false)이면 기존대로 board가 기본값이다(회귀 없음)', async () => {
    isMobileMock = false;
    stubFetch([{ id: 's-desktop', title: '데스크톱카드', status: 'backlog', priority: 'medium' }]);
    await mount();

    expect(container.textContent).toContain('스토리가 없어요');
  });

  it('모바일이라도 다열(board) 토글을 직접 누르면 그 선택이 뷰포트와 무관하게 유지된다(칸반 opt-in)', async () => {
    isMobileMock = true;
    stubFetch([{ id: 's-toggle', title: '토글카드', status: 'backlog', priority: 'medium' }]);
    await mount();

    const boardToggle = container.querySelector<HTMLButtonElement>('button[title="보드 보기"]');
    expect(boardToggle).not.toBeNull();
    await act(async () => { boardToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain('스토리가 없어요');
  });

  it('list 뷰의 행은 board 뷰와 동일한 StoryCard atom(SID 3018)을 재사용한다 — full-width(max-w-none)로', async () => {
    isMobileMock = true;
    stubFetch([{ id: 's-atom', title: '원자카드', status: 'backlog', priority: 'medium' }]);
    await mount();

    // CardVariant(ProofCapsule density="card")의 CutCornerShell 마커 — 예전 ListStoryRow
    // 자체 마크업(rounded-lg border, proof-surface 없음)엔 없던 클래스라 진짜 atom 재사용의
    // 증거. story #7d7634ee(P0)로 컷코너(proof-cut)가 재질(proof-surface)로 교체됨.
    expect(container.innerHTML).toContain('proof-surface');
    // max-w-[280px](desktop 컬럼 고정폭 전제) 캡이 이 경로에선 max-w-none으로 override돼야
    // full-width row가 된다 — cn()=twMerge라 나중 클래스가 이긴다(story-card.tsx 확認).
    expect(container.innerHTML).toContain('max-w-none');
    expect(container.innerHTML).not.toContain('max-w-[280px]');
  });
});

// story #3287([도메인탈고정·축1 Phase1] AC4) — org 라벨 오버라이드가 클래식(5-status)
// 컬럼 헤더 텍스트만 바꾸고, canonical status(드래그·색상·전이 판정에 쓰는 col.id)와
// 신뢰축(TRUST_COLUMNS, 다른 어휘) 라벨은 절대 안 건드리는지 실 렌더로 고정.
describe('KanbanBoard — org 라벨 오버라이드 소비(#3287 AC4)', () => {
  function stubFetchWithDomainLabels(
    stories: Array<Record<string, unknown> & { status: string }>,
    labels: Array<{ domain: string; canonical_slug: string; label_ko: string | null; label_en: string | null }>,
  ) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/stories?')) {
        const status = new URL(url, 'http://localhost').searchParams.get('status');
        const matched = stories.filter((s) => s.status === status);
        return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
      }
      if (typeof url === 'string' && url.includes('/domain-labels')) {
        return { ok: true, json: async () => labels };
      }
      return { ok: false, json: async () => null };
    }));
  }

  beforeEach(() => {
    useDashboardContextMock.mockReturnValue({
      currentTeamMemberId: 'me-1', orgId: 'org-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human',
      bottomDockBannerSlot: bannerSlot,
    });
  });

  it('클래식(5-status) 컬럼 헤더는 오버라이드 라벨로 바뀌고, 오버라이드 없는 컬럼은 canonical i18n 그대로다', async () => {
    stubFetchWithDomainLabels(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }],
      [{ domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' }],
    );
    await mount();
    const classicBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '5단계 클래식');
    expect(classicBtn, '클래식 토글 버튼을 못 찾음').toBeDefined();
    await act(async () => { classicBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('아이디어'); // backlog 오버라이드 적용
    expect(container.textContent).not.toContain('백로그'); // canonical i18n 문구는 더는 안 보임
    expect(container.textContent).toContain('완료'); // done엔 오버라이드 없음 — canonical i18n 그대로
  });

  it('오버라이드 미설정(빈 목록)이면 전 컬럼이 기존 canonical i18n 라벨 그대로다(회귀 0)', async () => {
    stubFetchWithDomainLabels([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }], []);
    await mount();
    const classicBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '5단계 클래식');
    await act(async () => { classicBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('백로그');
  });

  it('신뢰축(TRUST_COLUMNS) 컬럼 헤더는 자기 어휘 그대로지만, 카드 내부 상태 배지는 story.status 오버라이드를 받는다', async () => {
    stubFetchWithDomainLabels(
      [{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', trust_stage: 'queued' }],
      [{ domain: 'status', canonical_slug: 'backlog', label_ko: '아이디어', label_en: 'Idea' }],
    );
    await mount(); // 기본값=trust축(P0-04) — 클래식 토글 안 누름.
    // 컬럼 헤더(대기/실행 중/...)는 TRUST_COLUMNS 고유 어휘 그대로 — statusLabel()을 안 씀.
    expect(container.textContent).toContain('입력 필요');
    // 카드 내부 배지는 story.status(canonical, 축과 무관)를 보여주므로 오버라이드가 반영된다.
    expect(container.textContent).toContain('아이디어');
  });
});

// story #4306(유나 4646 재측) — 보드 필터 메뉴(스프린트 · 목표 · 담당자 · 라벨)를 열면 초점이 검색칸으로 가야 한다. 예전엔 메뉴가 열리며
// 첫 항목으로 초점을 옮겨(키보드로 열 때 Base UI 목록 탐색) 입력이 타이프어헤드로 새고 검색칸이 비었다. 뮤테이션: MenuSearchInput 대신
// 옛 `<Input autoFocus>`로 되돌리면 RED.
describe('KanbanBoard — 필터 메뉴를 열면 초점 = 검색칸(story #4306)', () => {
  const B = koMessages.board as unknown as Record<string, string>;
  const frames = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    }
  };
  const triggerFor = (label: string) => [...container.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

  it.each([
    ['스프린트', 'allSprints', 'searchSprints'],
    ['목표', 'allEpics', 'searchEpics'],
    ['담당자', 'allAssignees', 'searchAssignees'],
  ])('⭐%s 필터 — 키보드로 열어도 초점이 검색칸 · 바로 입력하면 검색칸에 들어간다', async (_name, triggerKey, placeholderKey) => {
    stubFetch([]);
    await mount();
    const trigger = triggerFor(B[triggerKey]!);
    expect(trigger, `${triggerKey} 트리거`).toBeDefined();
    await act(async () => { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); trigger!.click(); });
    await frames();
    const input = document.querySelector(`input[placeholder="${B[placeholderKey]}"]`) as HTMLInputElement | null;
    expect(input, `${placeholderKey} 검색칸`).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('⭐담당자 — 열자마자 입력하면(검색칸을 누르지 않고) 검색칸에 들어가 목록이 좁혀진다', async () => {
    stubFetch([], [
      { id: 'm1', name: 'Alice', type: 'human' },
      { id: 'm2', name: 'Bob', type: 'human' },
    ]);
    await mount();
    const trigger = triggerFor(B.allAssignees!);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    await frames();
    const typed = document.activeElement as HTMLInputElement;
    expect(typed.placeholder).toBe(B.searchAssignees);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(typed, 'ali');
      typed.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const names = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');
    expect(names.some((n) => n.includes('Alice'))).toBe(true);
    expect(names.some((n) => n.includes('Bob'))).toBe(false);
  });

  it('포인터로 열어도(pointerdown → click) 초점 = 검색칸', async () => {
    stubFetch([]);
    await mount();
    const trigger = triggerFor(B.allSprints!);
    await act(async () => {
      const pointer = (type: string) => Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }), { pointerType: 'mouse', pointerId: 1 });
      trigger!.dispatchEvent(pointer('pointerdown'));
      trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      trigger!.dispatchEvent(pointer('pointerup'));
      trigger!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });
    await frames();
    expect((document.activeElement as HTMLInputElement | null)?.placeholder).toBe(B.searchSprints);
  });

  it('검색칸에서 누른 글자는 메뉴 타이프어헤드로 새지 않는다(초점이 항목으로 튀지 않음)', async () => {
    stubFetch([], [
      { id: 'm1', name: 'Alice', type: 'human' },
      { id: 'm2', name: 'Bob', type: 'human' },
    ]);
    await mount();
    const trigger = triggerFor(B.allAssignees!);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    await frames();
    const input = document.activeElement as HTMLInputElement;
    expect(input.placeholder).toBe(B.searchAssignees);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })); });
    await frames();
    expect(document.activeElement).toBe(input);
  });

  it('⭐Escape는 메뉴로 통과 — 메뉴가 닫히고 초점이 트리거로 돌아온다(까디르 QA · PO 10:06Z)', async () => {
    stubFetch([]);
    await mount();
    const trigger = triggerFor(B.allSprints!);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    await frames();
    const input = document.activeElement as HTMLInputElement;
    expect(input.placeholder).toBe(B.searchSprints);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await frames();
    expect(document.querySelector(`input[placeholder="${B.searchSprints}"]`)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('⭐↓ = 목록 첫 항목(보이는 순서 · «전체 담당자») → 첫 항목에서 ↑ = 검색칸으로(맨 끝으로 감지 않음) · 유나 확정', async () => {
    stubFetch([], [{ id: 'm1', name: 'Alice', type: 'human' }, { id: 'm2', name: 'Bob', type: 'human' }]);
    await mount();
    const trigger = triggerFor(B.allAssignees!);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    await frames();
    const input = document.activeElement as HTMLInputElement;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    await frames();
    const first = document.activeElement as HTMLElement;
    expect(first.getAttribute('role')).toBe('menuitem');
    expect(first).toBe(document.querySelector('[role="menu"] [role="menuitem"]'));
    expect(first.textContent).toContain(B.allAssignees);
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    await frames();
    expect(document.activeElement).toBe(input);
  });

  it('Enter(검색칸) = 아무것도 안 함 — 메뉴는 열린 채 · 초점 검색칸', async () => {
    stubFetch([]);
    await mount();
    const trigger = triggerFor(B.allSprints!);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    await frames();
    const input = document.activeElement as HTMLInputElement;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await frames();
    expect(document.activeElement).toBe(input);
    expect(document.querySelector(`input[placeholder="${B.searchSprints}"]`)).not.toBeNull();
  });

  it.each([
    ['allSprints', 'searchSprints'],
    ['allEpics', 'searchEpics'],
    ['allAssignees', 'searchAssignees'],
  ])('검색칸 접근 이름 = 번역된 자리표시 글자(끝 말줄임 뺌) — %s', async (triggerKey, placeholderKey) => {
    stubFetch([]);
    await mount();
    const trigger = triggerFor(B[triggerKey]!);
    await act(async () => { trigger!.focus(); trigger!.click(); });
    await frames();
    const input = document.querySelector(`input[placeholder="${B[placeholderKey]}"]`)!;
    expect(input.getAttribute('aria-label')).toBe(B[placeholderKey]!.replace(/(\.{3}|…)\s*$/, '').trim());
    expect(input.getAttribute('aria-label')).not.toMatch(/(\.{3}|…)$/);
  });
});

// story #4284 — BE `team_members.name`은 nullable(표시 이름 없는 휴먼 · story #3758). FE 타입이 `name: string`이라 tsc가 못 잡았고,
// 이름 없는 구성원이 하나라도 있으면 담당자 필터 렌더(`m.name.toLowerCase()`)에서 throw → 일감 보드 전체가 오류 화면이었다.
describe('KanbanBoard — 이름 없는 구성원(story #4284)', () => {
  const MEMBERS = [
    { id: 'm-unnamed', name: null, type: 'human' },
    { id: 'm-named', name: '송윤재', type: 'human' },
    { id: 'a-1', name: '디디', type: 'agent' },
  ];

  async function openAssigneeFilter(): Promise<HTMLElement> {
    const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.board.allAssignees));
    expect(trigger, '담당자 필터 버튼').toBeTruthy();
    // DropdownMenu는 Base UI Menu — 클릭으로 열린다(내용은 body 포털).
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu, '담당자 필터 메뉴').toBeTruthy();
    return menu!;
  }

  it('⭐보드가 오류 화면 없이 그려지고, 담당자 필터에 «이름 없는 구성원»이 뜬다', async () => {
    stubFetch([{ id: 's1', title: '이름 없는 담당자 스토리', status: 'backlog', priority: 'medium', assignee_id: 'm-unnamed' }], MEMBERS);
    await mount();
    expect(container.textContent).toContain('이름 없는 담당자 스토리');
    const menu = await openAssigneeFilter();
    expect(menu.textContent).toContain(koMessages.common.memberUnnamed);
    expect(menu.textContent).toContain('송윤재');
  });

  it('⭐보드 전체 검색 — 담당자의 보이는 라벨(«이름 없는»)로도 스토리가 찾힌다', async () => {
    stubFetch([
      { id: 's1', title: '이름 없는 사람 스토리', status: 'backlog', priority: 'medium', assignee_id: 'm-unnamed' },
      { id: 's2', title: '실명 스토리', status: 'backlog', priority: 'medium', assignee_id: 'm-named' },
    ], MEMBERS);
    await mount();
    const toggle = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === koMessages.board.searchPlaceholder)!;
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '이름 없는 구성원'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.textContent).toContain('이름 없는 사람 스토리');
    expect(container.textContent).not.toContain('실명 스토리');
  });

  it('⭐이름 없는 사람 둘 → 필터 행이 id 꼬리로 갈리고, 고른 뒤 트리거도 같은 라벨 · 묶음에 하나뿐인 이름 없는 에이전트는 꼬리 없음(유나 판정)', async () => {
    const TWO = [
      { id: 'a1000000-0000-4000-8000-000000000001', name: null, type: 'human' },
      { id: 'b2000000-0000-4000-8000-000000000002', name: null, type: 'human' },
      { id: 'c3000000-0000-4000-8000-000000000003', name: null, type: 'agent' },
    ];
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: null }], TWO);
    await mount();
    const menu = await openAssigneeFilter();
    const rowTexts = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim() ?? '');
    const unnamed = koMessages.common.memberUnnamed;
    expect(rowTexts).toContain(`${unnamed} · a1000000`);
    expect(rowTexts).toContain(`${unnamed} · b2000000`);
    expect(rowTexts, '에이전트 묶음엔 이름 없는 행이 하나 — 꼬리 없음').toContain(unnamed);
  });

  it('⭐이름 없는 사람 둘 중 하나를 고른 상태 → 필터 트리거도 그 행 라벨(id 꼬리)', async () => {
    searchRef.current = 'assignee_id=b2000000-0000-4000-8000-000000000002';
    try {
      stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: null }], [
        { id: 'a1000000-0000-4000-8000-000000000001', name: null, type: 'human' },
        { id: 'b2000000-0000-4000-8000-000000000002', name: null, type: 'human' },
      ]);
      await mount();
      const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(`${koMessages.common.memberUnnamed} · b2000000`));
      expect(trigger, '필터 트리거가 고른 행과 같은 라벨').toBeTruthy();
    } finally {
      searchRef.current = '';
    }
  });

  it('담당자 검색 — 보이는 라벨로 찾는다(«이름 없는»으로 이름 없는 구성원이 걸리고, 실명 검색에서 오류 없음)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium', assignee_id: null }], MEMBERS);
    await mount();
    const menu = await openAssigneeFilter();
    const input = menu.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '이름 없는'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(menu.textContent).toContain(koMessages.common.memberUnnamed);
    expect(menu.textContent).not.toContain('송윤재');
    await act(async () => { setter.call(input, '송윤'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(menu.textContent).toContain('송윤재');
    expect(menu.textContent).not.toContain(koMessages.common.memberUnnamed);
  });
});
