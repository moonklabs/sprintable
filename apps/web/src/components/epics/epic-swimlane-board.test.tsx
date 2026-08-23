// @vitest-environment jsdom
//
// story #2931(2930-I3 분리, 유나 (a) 시안 확定) — 에픽 스윔레인. 워크스페이스 «뷰» 3종의
// 마지막 조각(행=에픽, 열=H4 공유 축). dnd-kit DndContext를 부분 모킹해 onDragEnd를 캡처하는
// 관례는 kanban-board.test.tsx의 STEER qa:changes 대응(2026-08-22)과 동형.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EpicSwimlaneBoard } from './epic-swimlane-board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// QA changes 4R 자체검산 — waitForCondition의 내부 vi.waitFor(timeout:5000)가 vitest 기본
// 테스트 타임아웃(5000ms)과 정확히 경합해, 실패 시 vitest 자체 타임아웃이 먼저 죽여버려
// waitForCondition의 진단(callLog) 에러가 리포트에 아예 안 뜨는 자리를 직접 시뮬레이션해
// 발견(프로덕션 bulk PATCH 호출을 임시로 꺼서 재현). 파일 전체 테스트 타임아웃을 여유
// 있게 올려 "내부 waitFor가 먼저 타임아웃→진단 에러가 실제로 리포트된다"를 보장한다.
vi.setConfig({ testTimeout: 8000 });

// ⚠️QA changes 5R 자체검산(2026-08-22) — 5R 처방으로 beforeEach에 `localStorage.clear()`를
// 추가하려다 직접 실행해 보니 이 워크스페이스의 jsdom 환경엔 `window.localStorage`가 아예
// 없다(undefined — probe로 typeof 직접 확認, "ExperimentalWarning: localStorage is not
// available" 경고가 그 증거). loadAxisMode/saveAxisMode의 프로덕션 try/catch가 매번 조용히
// 삼켜서 로컬에서는 axisMode가 순수 in-memory useState로만 동작 — 크로스테스트 누수
// 메커니즘 자체가 로컬에서 구조적으로 재현 불가능했다(이게 「로컬 3회 재실행 전부 green」의
// 진짜 이유). bare `localStorage.clear()`도 undefined라 즉시 throw(직접 확認).
//
// 그래서 존재 여부에 기대는 guard(?.  나 try/catch)가 아니라, 매 테스트마다 진짜 동작하는
// in-memory Storage 구현으로 window.localStorage/bare localStorage를 통째로 교체한다 —
// CI가 갖고 있(었)을 실 localStorage와 로컬 환경의 격차 자체를 없애, 이 회귀가드가 로컬
// 에서도 RED→GREEN으로 실제 검증되고, CI와 동일한 신뢰도로 항상 동작하게 만든다.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return [...this.store.keys()][index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, value); }
}

// flow-client.test.tsx와 동형 관례 — TopBarSlot은 TopBarProvider 컨텍스트가 필요한 실 크롬
// 컴포넌트라 이 컴포넌트의 로직과 무관한 부분은 얕게 스텁한다. WorkspaceFrameTabs가
// useRouter/useParams를 쓰므로 next/navigation도 동형 스텁.
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title }: { title: React.ReactNode }) => <div>{title}</div>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ ws: 'ws1', proj: 'proj1' }),
}));
// QA changes 10R HIGH③(카디르+codex, 2026-08-22) — StoryDetailPanel의 영구삭제 트리거는
// HumanOnlyAction(useDashboardContext().currentMemberType==='human')로 감싸여 있다
// (kanban-board.test.tsx와 동형 관례). Provider 없이는 기본 컨텍스트값에 currentMemberType이
// 아예 없어(fail-closed) 버튼이 항상 숨는다 — onDeleteSuccess 배선을 실제로 증명하려면 human으로 스텁.
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' }),
}));

const { capturedDragEndHandlers, capturedDragStartHandlers } = vi.hoisted(() => ({
  capturedDragEndHandlers: [] as Array<(event: unknown) => void>,
  // story #2954 — draggingActive 시각화(onDragStart→dim) 검증용. 기존 onDragEnd 캡처
  // 관례와 동형으로 확장.
  capturedDragStartHandlers: [] as Array<(event: unknown) => void>,
}));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ onDragEnd, onDragStart, children }: { onDragEnd?: (event: unknown) => void; onDragStart?: (event: unknown) => void; children?: React.ReactNode }) => {
      if (onDragEnd) capturedDragEndHandlers.push(onDragEnd);
      if (onDragStart) capturedDragStartHandlers.push(onDragStart);
      return children;
    },
  };
});

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  capturedDragEndHandlers.length = 0;
  capturedDragStartHandlers.length = 0;
  // ⚠️QA changes 5R(PR#3377, 카디르+codex, 2026-08-22) — 진단 로그(4R)가 답을 줬다: bulk
  // 호출이 아예 없었다(자원 경쟁 기각). 근본원인: 여기 localStorage 초기화가 없어 "토글
  // 클릭 시 트러스트 축으로 바뀐다" 테스트가 남긴 axisMode='trust'(loadAxisMode/
  // saveAxisMode 키, 같은 projectId='p1')를 파일 내 뒤 테스트가 그대로 물려받으면
  // TRUST_COLUMN_TO_STATUS['in-progress']=undefined→newStatus undefined→bulk 게이트
  // (columnChanged && newStatus)가 조용히 스킵된다. CI의 파일 내 테스트 실행 순서/샤딩이
  // 로컬과 달라 "항상 같은 2건(둘 다 bulk 경로)"으로만 재현된 것 — 결정론적 환경 차.
  // 가설과 무관하게도 테스트 간 격리는 그 자체로 정당하다.
  //
  // (자체검산 후 처방 수정) 이 워크스페이스 jsdom엔 window.localStorage가 아예 없어
  // (undefined) bare `localStorage.clear()`는 즉시 throw한다 — 존재 유무에 기대는 대신
  // 매 테스트마다 진짜 동작하는 MemoryStorage로 통째 교체해 사용한다(위 클래스 주석 참고).
  const freshStorage = new MemoryStorage();
  vi.stubGlobal('localStorage', freshStorage);
  Object.defineProperty(window, 'localStorage', { value: freshStorage, configurable: true, writable: true });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

type FetchStub = {
  stories?: Array<Record<string, unknown>>;
  epics?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  bulkPatchSpy?: (body: unknown) => void;
  singlePatchSpy?: (id: string, body: unknown) => void;
  // ⚠️QA changes(PR#3377 HIGH) — 500 부분 실패 재현용. false면 그 PATCH가 ok:false(HTTP 500류)로
  // 응답한다(fetchWithAuth는 401 외 비-ok를 throw 안 하고 그냥 반환 — try/catch만으론 못 잡히는
  // 자리를 직접 재현).
  singlePatchOk?: boolean;
  bulkPatchOk?: boolean;
  storiesGetSpy?: () => void;
  // ⚠️QA changes 6R HIGH②(PR#3377, 카디르+codex, 2026-08-22) — 서버 maxLimit=100 clamp +
  // hasMore/nextCursor 소진 재현용. 지정하면 `stories` 대신 커서(=페이지 인덱스 문자열)
  // 기준으로 순차 페이지를 응답한다.
  storyPages?: Array<{ stories: Array<Record<string, unknown>>; hasMore: boolean }>;
  // ⚠️QA changes 7R(PR#3377, 카디르+codex, 2026-08-22) — /api/goals도 동일 clamp. storyPages와
  // 동형(에픽 버전).
  epicPages?: Array<{ epics: Array<Record<string, unknown>>; hasMore: boolean }>;
  // ⚠️QA changes 8R HIGH①(PR#3377, 카디르+codex, 2026-08-22) — trust_stage 응답 병합 재현용.
  // 지정하면 PATCH 응답 data에 그대로 실려 온다(kanban-board와 동형 okItem 병합 검증).
  singlePatchResponseData?: Record<string, unknown>;
  bulkPatchResponseData?: Array<Record<string, unknown>>;
  // ⚠️QA changes 8R HIGH②(PR#3377, 카디르+codex, 2026-08-22) — fetchAllPages 중간 실패
  // 재현용. true면 /api/stories? GET이 ok:false(500)로 응답한다.
  storiesFetchFails?: boolean;
  // ⚠️QA changes 9R(PR#3377, 카디르+codex, 2026-08-22) — 안전판(PAGE_HARD_CAP=50) 소진 재현용.
  // true면 /api/stories? GET이 몇 번을 불러도 항상 hasMore:true인 무한 스트림처럼 응답한다
  // (storyPages 배열 길이로는 이 시나리오를 못 만든다 — 소진 후 자동 hasMore:false 낙하).
  storiesAlwaysHasMore?: boolean;
  // QA changes 10R HIGH③(카디르+codex, 2026-08-22) — StoryDetailPanel 배선 검증용(tasks
  // 실 fetch·delete 성공 시 카드 제거). story_id별 태스크 목록.
  tasksByStoryId?: Record<string, Array<Record<string, unknown>>>;
  deleteStorySpy?: (id: string) => void;
};

// ⚠️QA changes 4R(PR#3377, 카디르+codex, 2026-08-22) — CI 실행 명령까지 정확 재현해 8+1회
// 전부 green(로컬 재현 실패) — CI 전용·같은 2건(둘 다 bulk 경로) 3연속. 재현 못 하는 실패는
// 흔적을 남기는 수밖에 없다 — 모든 fetch 호출을 순서대로 기록해, waitFor가 결국 timeout나면
// 그 로그를 에러 메시지에 실어 「bulk가 아예 안 불림(환경/로직 차)」 vs 「늦게 불림(순수
// 지연)」을 CI 로그만으로 갈라준다(페드루 의심 — 순수 지연이면 레인 테스트도 가끔 튀어야
// 하는데 항상 bulk 2건만이라 결정론적 환경 차 가능성).
let callLog: string[] = [];

function stubFetch({ stories = [], epics = [], members = [], bulkPatchSpy, singlePatchSpy, singlePatchOk = true, bulkPatchOk = true, storiesGetSpy, storyPages, epicPages, singlePatchResponseData, bulkPatchResponseData, storiesFetchFails = false, storiesAlwaysHasMore = false, tasksByStoryId = {}, deleteStorySpy }: FetchStub) {
  callLog = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    callLog.push(`${init?.method ?? 'GET'} ${url}`);
    if (typeof url === 'string' && url.startsWith('/api/stories/bulk') && init?.method === 'PATCH') {
      bulkPatchSpy?.(JSON.parse(init.body ?? '{}'));
      if (!bulkPatchOk) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, json: async () => ({ data: bulkPatchResponseData ?? [] }) };
    }
    if (typeof url === 'string' && /^\/api\/stories\/[^/]+$/.test(url) && init?.method === 'DELETE') {
      const id = url.split('/').pop()!;
      deleteStorySpy?.(id);
      return { ok: true, json: async () => ({ data: { id } }) };
    }
    if (typeof url === 'string' && /^\/api\/stories\/[^/]+$/.test(url) && init?.method === 'PATCH') {
      const id = url.split('/').pop()!;
      singlePatchSpy?.(id, JSON.parse(init.body ?? '{}'));
      if (!singlePatchOk) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, json: async () => ({ data: singlePatchResponseData ?? {} }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/tasks?')) {
      const storyId = new URL(url, 'http://localhost').searchParams.get('story_id') ?? '';
      return { ok: true, json: async () => ({ data: tasksByStoryId[storyId] ?? [], meta: { hasMore: false, nextCursor: null } }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      storiesGetSpy?.();
      if (storiesFetchFails) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      if (storiesAlwaysHasMore) {
        const cursorParam = new URL(url, 'http://localhost').searchParams.get('cursor');
        const pageIndex = cursorParam ? Number(cursorParam) : 0;
        return { ok: true, json: async () => ({ data: [], meta: { hasMore: true, nextCursor: String(pageIndex + 1) } }) };
      }
      if (storyPages) {
        const cursorParam = new URL(url, 'http://localhost').searchParams.get('cursor');
        const pageIndex = cursorParam ? Number(cursorParam) : 0;
        const page = storyPages[pageIndex] ?? { stories: [], hasMore: false };
        const nextCursor = page.hasMore ? String(pageIndex + 1) : null;
        return { ok: true, json: async () => ({ data: page.stories, meta: { hasMore: page.hasMore, nextCursor } }) };
      }
      // QA changes 10R HIGH①(카디르+codex, 2026-08-22) — 실 /api/stories 프록시는
      // buildCursorPageMeta로 meta를 항상 짓는다(app/api/stories/route.ts) — 이 고정
      // (storyPages/epicPages 안 쓰는 단순 케이스)이 meta 없이 응답하던 게 실 BE와
      // 어긋난 지점. malformed 판정(HIGH① 처방)이 이걸 그대로 통과시키면 모든 기본
      // 테스트가 "meta 규약 밖"으로 throw돼 loadError로 떨어진다 — 실 계약대로 정정.
      return { ok: true, json: async () => ({ data: stories, meta: { hasMore: false, nextCursor: null } }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/goals?')) {
      if (epicPages) {
        const cursorParam = new URL(url, 'http://localhost').searchParams.get('cursor');
        const pageIndex = cursorParam ? Number(cursorParam) : 0;
        const page = epicPages[pageIndex] ?? { epics: [], hasMore: false };
        const nextCursor = page.hasMore ? String(pageIndex + 1) : null;
        return { ok: true, json: async () => ({ data: page.epics, meta: { hasMore: page.hasMore, nextCursor } }) };
      }
      return { ok: true, json: async () => ({ data: epics, meta: { hasMore: false, nextCursor: null } }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/members')) {
      return { ok: true, json: async () => ({ data: members }) };
    }
    return { ok: false, json: async () => null };
  }));
}

// ⚠️QA changes 3R(PR#3377, 카디르+codex, 2026-08-22) — 1R 처방(고정 tick 카운팅→단일
// flush())도 여전히 «시간 세기»의 동류였다(CI에서 bulk 경로+신규 500 테스트가 같은
// bulkBody:null 패턴으로 재발). 근본은 "얼마나 기다릴지"를 매직 상수(N tick·1 flush)로
// 정하는 것 자체 — 환경마다 실제로 필요한 시간이 다르면 어떤 상수도 결국 깨진다. 그래서
// «시간 기다리기»를 완전히 버리고 «상태 기다리기»(vi.waitFor — 조건이 참이 될 때까지
// 폴링, 실 타이머 기반이라 event loop 홉 수와 무관)로 클래스를 닫는다. positive 케이스
// (스파이가 호출됐다/재조회 카운트가 늘었다)만 waitFor 대상 — negative 케이스(호출 자체가
// 없어야 함)는 "없다"를 폴링할 수 없으므로 짧은 flush 유지(부재 확認은 더 오래 기다려도
// 더 확실해질 뿐 더 flaky해지지 않는다 — positive-wait와 위험 성격이 다름).
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// QA changes 4R — ①timeout 5000ms로 명시 상향(카디르 CI 러너 자원 경쟁 가설) ②timeout
// 시 fetch 호출 로그를 에러 메시지에 동봉(위 callLog 주석 참고) — 5R이 오더라도 CI 로그
// 자체가 "bulk 자체가 안 불림" vs "불렸는데 이 창을 넘겨 늦게 옴"을 갈라준다.
async function waitForCondition(check: () => boolean, label: string) {
  await vi.waitFor(() => {
    if (!check()) {
      throw new Error(`${label} — timeout. fetch call log(순서대로):\n${callLog.map((l, i) => `  ${i}: ${l}`).join('\n') || '  (없음)'}`);
    }
  }, { timeout: 5000 });
}

async function mount(stub: FetchStub) {
  stubFetch(stub);
  await act(async () => {
    root.render(withIntl(<EpicSwimlaneBoard projectId="p1" />));
  });
  // «시간 기다리기» 대신 «상태 기다리기» — 로딩 문구(TopBarSlot 타이틀은 로딩 중에도
  // 항상 보이므로 신호가 못 됨) 대신 로드 完了 분기에서만 뜨는 축 토글 텍스트로 조건을 잰다.
  await act(async () => {
    await waitForCondition(() => container.textContent?.includes('5-status 클래식') ?? false, 'mount 로딩 完了');
  });
}

describe('EpicSwimlaneBoard — 행 구성(story #2931)', () => {
  it('active 에픽만 레인으로 뜬다(archived/done 등 비active는 기본 숨김)', async () => {
    await mount({
      epics: [
        { id: 'e1', title: '활성 에픽', status: 'active', position: 1 },
        { id: 'e2', title: '완료된 에픽', status: 'done', position: 2 },
      ],
    });
    expect(container.textContent).toContain('활성 에픽');
    expect(container.textContent).not.toContain('완료된 에픽');
  });

  it('status 필드가 없어도(구 백필) active로 취급한다(정직한 부재를 숨김으로 안 벌함)', async () => {
    await mount({ epics: [{ id: 'e1', title: '값없는 에픽', position: 1 }] });
    expect(container.textContent).toContain('값없는 에픽');
  });

  it('미할당 스토리(epic_id=null)는 별도 "미할당" 레인에 뜬다', async () => {
    await mount({
      stories: [{ id: 's1', title: '주인없는카드', status: 'backlog', priority: 'medium', epic_id: null }],
    });
    expect(container.textContent).toContain('미할당');
    expect(container.textContent).toContain('주인없는카드');
  });

  it('상위 3개 에픽은 바로 렌더, 나머지는 "더 보기" 토글 뒤에 접힌다', async () => {
    await mount({
      epics: [1, 2, 3, 4, 5].map((n) => ({ id: `e${n}`, title: `에픽${n}`, status: 'active', position: n })),
    });
    for (const n of [1, 2, 3]) expect(container.textContent).toContain(`에픽${n}`);
    expect(container.textContent).not.toContain('에픽4');
    expect(container.textContent).toContain('에픽 2개 더 보기');

    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('더 보기'));
    await act(async () => { toggle!.click(); });
    expect(container.textContent).toContain('에픽4');
    expect(container.textContent).toContain('에픽5');
  });

  // ⚠️QA changes 6R HIGH①(PR#3377, 카디르+codex, 2026-08-22) — kanban-board의 문서화 불변식
  // (story #2187/b8157376 — is_excluded=true인 라이브 QA 임시 카드는 삭제 권한이 없는
  // 화면에서라도 무조건 숨김·토글 없음)을 이 신설 뷰가 상속하지 않았다 — 노출되면 레인
  // 카운트·상위3 큐레이션이 부풀려진다.
  it('is_excluded=true인 카드는 무조건 숨는다(kanban-board와 동형 불변식, 토글 없음)', async () => {
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [
        { id: 's1', title: '정상카드', status: 'backlog', priority: 'medium', epic_id: 'e1' },
        { id: 's2', title: '임시QA카드', status: 'backlog', priority: 'medium', epic_id: 'e1', is_excluded: true },
      ],
    });
    expect(container.textContent).toContain('정상카드');
    expect(container.textContent).not.toContain('임시QA카드');
  });

  // ⚠️QA changes 6R HIGH②(PR#3377, 카디르+codex, 2026-08-22) — /api/stories 프록시는
  // maxLimit=100으로 clamp한다. 기존 limit=1000 단발 요청은 hasMore/nextCursor를 소비하지
  // 않아 100건 초과 프로젝트에서 조용히 잘렸다. 2페이지 모킹으로 두 페이지 모두 실제로
  // 소진되는지(=1페이지에서 멈추지 않는지) 직접 증명한다.
  it('100건 초과(다중 페이지)여도 hasMore를 소진해 전량을 반영한다(조용한 누락 금지)', async () => {
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      storyPages: [
        { stories: [{ id: 's1', title: '1페이지카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }], hasMore: true },
        { stories: [{ id: 's2', title: '2페이지카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }], hasMore: false },
      ],
    });
    expect(container.textContent).toContain('1페이지카드');
    expect(container.textContent).toContain('2페이지카드'); // 두 번째 페이지가 조용히 누락되지 않았음.
  });

  // ⚠️QA changes 7R(PR#3377, 카디르+codex, 2026-08-22) — 원 발견의 «에픽» 절반: /api/goals도
  // 동일 maxLimit=100 clamp라 활성 에픽 100+ 프로젝트에서 레인 자체가 조용히 누락됐다.
  // stories와 동형으로 hasMore 소진 검증.
  it('에픽도 100건 초과(다중 페이지)면 hasMore를 소진해 레인이 조용히 누락되지 않는다', async () => {
    await mount({
      epicPages: [
        { epics: [{ id: 'e1', title: '1페이지에픽', status: 'active', position: 1 }], hasMore: true },
        { epics: [{ id: 'e2', title: '2페이지에픽', status: 'active', position: 2 }], hasMore: false },
      ],
    });
    expect(container.textContent).toContain('1페이지에픽');
    expect(container.textContent).toContain('2페이지에픽'); // 두 번째 페이지 에픽 레인이 조용히 누락되지 않았음.
  });
});

describe('EpicSwimlaneBoard — 로드 실패(story #2931, QA changes 8R HIGH②)', () => {
  // ⚠️QA changes 8R HIGH②(카디르+codex, 2026-08-22) — fetchAllPages의 `!res.ok → break`가
  // 중간 실패를 부분 집합을 완전 집합처럼 반환했다(6R/7R이 막으려던 "조용한 누락"과 같은
  // 클래스, 실패 경로에서 재발). 이제 throw로 승격해 fetchAll이 정직한 에러 상태로 받는지
  // 직접 증명한다 — mount() 헬퍼는 로드 完了 신호(축 토글)를 기다리는데 에러 경로에선 그게
  // 영영 안 뜨니 이 테스트만 별도로 에러 문구를 신호로 기다린다.
  it('/api/stories 로드가 실패하면 부분 데이터를 렌더하지 않고 정직한 에러 상태를 보인다', async () => {
    stubFetch({
      epics: [{ id: 'e1', title: '부분로드에픽', status: 'active', position: 1 }],
      storiesFetchFails: true,
    });
    await act(async () => {
      root.render(withIntl(<EpicSwimlaneBoard projectId="p1" />));
    });
    await waitForCondition(
      () => container.textContent?.includes('불러오지 못했습니다') ?? false,
      '로드 실패 에러 상태',
    );
    expect(container.textContent).not.toContain('부분로드에픽'); // 부분 성공(에픽만 로드됨)을 완전한 것처럼 보이지 않는다.
    expect(container.textContent).toContain('다시 시도');
  });

  // ⚠️QA changes 9R(카디르+codex, 2026-08-22) — 8R②가 세운 "부분-성공 금지" 원칙이 중간
  // 실패 경로엔 섰지만, 안전판(PAGE_HARD_CAP) 소진 경로엔 아직 안 섰었다 — 마지막 페이지가
  // hasMore=true인 채로 루프가 끝나도 조용히 return했다(같은 클래스). 무한 hasMore:true
  // 스트림으로 안전판 소진을 직접 재현한다.
  it('안전판(하드캡) 소진 시에도 아직 더 있으면(hasMore=true) 조용히 반환하지 않고 에러 상태를 보인다', async () => {
    stubFetch({ storiesAlwaysHasMore: true });
    await act(async () => {
      root.render(withIntl(<EpicSwimlaneBoard projectId="p1" />));
    });
    await waitForCondition(
      () => container.textContent?.includes('불러오지 못했습니다') ?? false,
      '안전판 소진 에러 상태',
    );
    expect(container.textContent).toContain('다시 시도');
  });

  // ⚠️QA changes 10R HIGH①(카디르+codex, 2026-08-22) — parseCursorMeta는 meta가 규약 A
  // 형태가 아니면(malformed) "더 보기 없음"으로 낙하한다(다른 소비처엔 의도된 graceful
  // fallback, story #2231 AC4). 이 뷰는 «전체 집합 필수»라 그 낙하를 자연 소진과 구분
  // 못 하면 8R②/9R이 막은 것과 같은 클래스(부분 집합을 완전 집합처럼 반환)가 재발한다 —
  // meta 자체가 규약 밖(offset+limit류)이면 자연 소진이 아니라 에러 상태여야 한다.
  it('/api/stories meta가 규약 A 형태가 아니면(malformed) 자연 소진으로 오분류하지 않고 에러 상태를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/stories?')) {
        return { ok: true, json: async () => ({ data: [], meta: { items: [], total: 0, offset: 0 } }) }; // 규약 C — 규약 A 아님.
      }
      if (typeof url === 'string' && url.startsWith('/api/goals?')) {
        return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/members')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => {
      root.render(withIntl(<EpicSwimlaneBoard projectId="p1" />));
    });
    await waitForCondition(
      () => container.textContent?.includes('불러오지 못했습니다') ?? false,
      'malformed meta 에러 상태',
    );
    expect(container.textContent).toContain('다시 시도');
  });

  // 같은 원칙의 대칭 케이스 — hasMore=true인데 nextCursor가 없는 모순 상태도 자연 소진이
  // 아니다(파서가 규약 A로는 파싱했지만 값 자체가 내적으로 모순).
  it('hasMore=true인데 nextCursor가 없으면(모순) 자연 소진으로 오분류하지 않고 에러 상태를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/stories?')) {
        return { ok: true, json: async () => ({ data: [], meta: { hasMore: true, nextCursor: null } }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/goals?')) {
        return { ok: true, json: async () => ({ data: [], meta: { hasMore: false, nextCursor: null } }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/members')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => {
      root.render(withIntl(<EpicSwimlaneBoard projectId="p1" />));
    });
    await waitForCondition(
      () => container.textContent?.includes('불러오지 못했습니다') ?? false,
      'hasMore/nextCursor 모순 에러 상태',
    );
    expect(container.textContent).toContain('다시 시도');
  });
});

describe('EpicSwimlaneBoard — 열 축 토글(story #2931, H4 공유)', () => {
  it('기본은 5-status 클래식 축 — 트러스트 컬럼 라벨이 안 보인다', async () => {
    await mount({ epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }] });
    expect(container.textContent).not.toContain('입력 필요');
  });

  it('토글 클릭 시 6단계 신뢰축 컬럼으로 바뀐다', async () => {
    await mount({ epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }] });
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    await act(async () => { toggle!.click(); });
    expect(container.textContent).toContain('입력 필요');
  });

  // ⚠️QA changes 5R(PR#3377 근본원인, 카디르+codex, 2026-08-22) — 바로 위 테스트가 이
  // projectId(p1)에 axisMode='trust'를 localStorage(loadAxisMode/saveAxisMode 키)에
  // 남긴다. beforeEach의 localStorage.clear()가 없었다면 이 테스트(파일 내 다음 순번)가
  // 그 잔존값을 그대로 물려받아 기본 classic 축 기대가 깨지고, 드래그도
  // TRUST_COLUMN_TO_STATUS['in-progress']=undefined→newStatus undefined→bulk 게이트가
  // 조용히 스킵된다(4R 진단 로그가 정확히 잡아낸 증상). 이 테스트가 그 cross-test 격리를
  // 직접 고정한다 — 선언 순서(직전 테스트 바로 뒤)가 재현 조건의 일부라 옮기지 않는다.
  it('[격리] 직전 테스트가 남긴 트러스트 축 잔존이 다음 마운트로 새지 않는다', async () => {
    let bulkBody: unknown = null;
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      bulkPatchSpy: (body) => { bulkBody = body; },
    });
    expect(container.textContent).not.toContain('입력 필요'); // 트러스트 라벨 부재 = classic 축으로 뜸.

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e1::in-progress' } });
      await waitForCondition(() => bulkBody !== null, '잔존 축 격리 — 같은 레인 내 컬럼 드래그(bulk PATCH)');
    });
    expect(bulkBody).toEqual({ items: [{ id: 's1', status: 'in-progress' }] }); // undefined status로 스킵되지 않았음.
  });
});

describe('EpicSwimlaneBoard — 드래그(story #2931)', () => {
  it('다른 에픽 레인으로 드래그하면 epic_id PATCH가 발화한다(같은 컬럼 — status는 안 건드림)', async () => {
    let patchedId: string | null = null;
    let patchedBody: unknown = null;
    await mount({
      epics: [
        { id: 'e1', title: '출발 에픽', status: 'active', position: 1 },
        { id: 'e2', title: '도착 에픽', status: 'active', position: 2 },
      ],
      stories: [{ id: 's1', title: '이동카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      singlePatchSpy: (id, body) => { patchedId = id; patchedBody = body; },
    });

    const handler = capturedDragEndHandlers.at(-1);
    expect(handler, 'handleDragEnd를 캡처 못 함').toBeDefined();
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e2::backlog' } });
      await waitForCondition(() => patchedBody !== null, '레인 간 드래그(epic_id PATCH)');
    });

    expect(patchedId).toBe('s1');
    expect(patchedBody).toEqual({ epic_id: 'e2' });
  });

  it('같은 에픽 레인 안에서 다른 컬럼으로 드래그하면 bulk status PATCH만 발화한다(epic_id는 안 건드림)', async () => {
    let bulkBody: unknown = null;
    let singlePatchCalled = false;
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '이동카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      bulkPatchSpy: (body) => { bulkBody = body; },
      singlePatchSpy: () => { singlePatchCalled = true; },
    });

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e1::in-progress' } });
      await waitForCondition(() => bulkBody !== null, '같은 레인 내 컬럼 드래그(bulk PATCH)');
    });

    expect(bulkBody).toEqual({ items: [{ id: 's1', status: 'in-progress' }] });
    expect(singlePatchCalled).toBe(false);
  });

  it('드래그 대상이 잠긴(파생) 트러스트 컬럼이면 조용히 무효(PATCH 0건 — H4와 동형 규율)', async () => {
    let anyPatchCalled = false;
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '카드', status: 'in-progress', priority: 'medium', epic_id: 'e1', trust_stage: 'running' }],
      bulkPatchSpy: () => { anyPatchCalled = true; },
      singlePatchSpy: () => { anyPatchCalled = true; },
    });
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    await act(async () => { toggle!.click(); });

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      // negative 케이스(호출이 «없어야» 함) — waitFor로 폴링할 조건이 없다(부재를 기다릴
      // 수 없음). flush()는 여기선 안전하다: 더 오래 기다려도 "여전히 없음"이 더 확실해질
      // 뿐 positive-wait처럼 "아직 안 왔을 뿐"이 실패로 오판될 위험이 없다.
      handler!({ active: { id: 's1' }, over: { id: 'e1::needs_input' } });
      await flush();
    });
    expect(anyPatchCalled).toBe(false);
  });

  // story #2954(유나 처방 — H4 kanban-trust-column.tsx 문법 이식, 신규 토큰·컴포넌트 0).
  // 처방①: at-rest(드래그 무관)에도 헤더에 Lock 표식 — 잠긴 열임을 드래그 시작 前에 미리 안다.
  it('트러스트 축의 잠긴(파생) 컬럼은 헤더에 항상 Lock 아이콘이 뜬다(at-rest)', async () => {
    await mount({ epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }] });
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    await act(async () => { toggle!.click(); });

    // 헤더는 격자 맨 위 1회만(레인마다 반복 안 함) — 잠긴 3열(needs_input/verified/merge_ready)
    // 각각에 Lock 아이콘 1개씩, 총 3개.
    expect(container.querySelectorAll('.lucide-lock').length).toBe(3);
  });

  // 처방②: 드래그 中에만 잠긴 열을 dim 처리(H4 kanban-trust-column.tsx:86,92 opacity-45 이식).
  // handleDragEnd:333의 targetLocked 방어(PATCH 0건)는 이미 있었지만 침묵 실패였다 — 시각이
  // 그 침묵을 메운다.
  it('드래그 中에만 잠긴(파생) 열 셀이 dim 처리되고, 드래그가 끝나면 원복된다', async () => {
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '카드', status: 'in-progress', priority: 'medium', epic_id: 'e1', trust_stage: 'running' }],
    });
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    await act(async () => { toggle!.click(); });

    const lockedCell = () => nthLaneCell(0, 2); // TRUST_COLUMNS[2] = needs_input(잠김).
    expect(lockedCell()?.className ?? '').not.toContain('opacity-45'); // at-rest — 아직 dim 아님.

    const startHandler = capturedDragStartHandlers.at(-1);
    expect(startHandler, 'onDragStart를 캡처 못 함').toBeDefined();
    await act(async () => { startHandler!({ active: { id: 's1' } }); });
    expect(lockedCell()?.className ?? '').toContain('opacity-45'); // 드래그 中 — dim.

    const endHandler = capturedDragEndHandlers.at(-1);
    await act(async () => { endHandler!({ active: { id: 's1' }, over: null }); });
    expect(lockedCell()?.className ?? '').not.toContain('opacity-45'); // 드래그 종료 — 원복.
  });

  // story #2931(PASS 판정·영구 테스트 없음은 비차단, 카디르 권고 2026-08-22) — 에픽 레인에서
  // 미할당 레인으로 드래그하면 epic_id가 null로 PATCH된다(반대 방향도 확認해 두는 회귀가드).
  it('에픽 레인에서 미할당 레인으로 드래그하면 epic_id=null로 PATCH된다', async () => {
    let patchedBody: unknown = null;
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      singlePatchSpy: (_id, body) => { patchedBody = body; },
    });

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: '__unassigned__::backlog' } });
      await waitForCondition(() => patchedBody !== null, '미할당 레인으로 드래그(epic_id=null PATCH)');
    });

    expect(patchedBody).toEqual({ epic_id: null });
  });

  // ⚠️QA changes(PR#3377 HIGH, 카디르+codex, 2026-08-22) — fetchWithAuth는 401 외 비-ok
  // (500 등)를 throw 없이 그냥 반환한다. try/catch만 믿으면 이 흔한 실패 모드에서 낙관 UI가
  // 서버 truth와 불일치한 채 영구 잔존한다(no-fiction 위반) — `if (!res.ok)` 명시 체크가
  // 실제로 재조회를 발동시키는지 직접 증명한다(단건 epic_id PATCH가 500인 케이스).
  it('epic_id PATCH가 500이면(throw 없이 ok:false) 재조회(fetchAll)가 실제로 발동한다', async () => {
    let storiesGetCount = 0;
    await mount({
      epics: [
        { id: 'e1', title: '출발', status: 'active', position: 1 },
        { id: 'e2', title: '도착', status: 'active', position: 2 },
      ],
      stories: [{ id: 's1', title: '카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      singlePatchOk: false,
      storiesGetSpy: () => { storiesGetCount += 1; },
    });
    expect(storiesGetCount).toBe(1); // 최초 mount 1회.

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e2::backlog' } });
      await waitForCondition(() => storiesGetCount === 2, 'epic_id PATCH 500→재조회');
    });

    expect(storiesGetCount).toBe(2); // 500 응답 後 fetchAll이 실제로 재발화(재조회로 정직 복구).
  });

  // 같은 클래스 — bulk(컬럼) PATCH 축도 동일 가드가 걸리는지 대칭 확認.
  it('bulk status PATCH가 500이면 재조회(fetchAll)가 실제로 발동한다', async () => {
    let storiesGetCount = 0;
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      bulkPatchOk: false,
      storiesGetSpy: () => { storiesGetCount += 1; },
    });
    expect(storiesGetCount).toBe(1);

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e1::in-progress' } });
      await waitForCondition(() => storiesGetCount === 2, 'bulk status PATCH 500→재조회');
    });

    expect(storiesGetCount).toBe(2);
  });

  // TRUST_COLUMNS 고정 순서(queued=0,running=1,needs_input=2,claimed_done=3,verified=4,
  // merge_ready=5,done=6) — SwimlaneColumnHeader가 맨 위에 7칸을 한 번 그리고, 그 뒤로
  // 레인마다 같은 순서로 7칸씩 그린다(헤더는 label 텍스트, 레인 칸은 카드). laneIndex번째
  // 레인의 columnIndex번째 칸을 반환.
  function nthLaneCell(laneIndex: number, columnIndex: number): Element | undefined {
    const cells = [...container.querySelectorAll('div[class*="w-\\[220px\\]"]')];
    return cells[7 + laneIndex * 7 + columnIndex];
  }

  // ⚠️QA changes 8R HIGH①(PR#3377, 카디르+codex, 2026-08-22) — 형제(kanban-board.tsx
  // handleTrustDragEnd, story #2933 H4 qa:changes)와 동형: 레인 변경(단건 epic_id PATCH)
  // 성공 응답에 실린 진짜 trust_stage를 병합하는지 직접 증명한다. 이전엔 "다음 SSE가
  // 채운다"는 거짓 주석뿐 — 이 컴포넌트엔 SSE 구독이 없어 카드가 옛 트러스트컬럼에
  // 영구 고정됐다.
  it('레인 변경(epic_id PATCH) 응답의 trust_stage를 병합한다(SSE 없음 — 응답 병합만이 유일한 갱신 경로)', async () => {
    await mount({
      epics: [
        { id: 'e1', title: '출발', status: 'active', position: 1 },
        { id: 'e2', title: '도착', status: 'active', position: 2 },
      ],
      stories: [{ id: 's1', title: '병합카드', status: 'backlog', priority: 'medium', epic_id: 'e1', trust_stage: 'queued' }],
      singlePatchResponseData: { id: 's1', trust_stage: 'running' },
    });
    const trustToggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    await act(async () => { trustToggle!.click(); });

    const handler = capturedDragEndHandlers.at(-1);
    // 컬럼은 그대로 queued(0)인 채 레인만 e2로 — laneChanged만 발화, columnChanged=false.
    // (자체검산 발견) waitForCondition을 dispatch와 같은 act() 안에 중첩하면 React가 그
    // act() 스코프가 열려있는 동안 커밋을 미뤄 폴링이 그 갱신을 영영 못 보고 데드락처럼
    // timeout난다 — dispatch act()를 먼저 닫고, DOM 조건 대기는 그 밖에서 한다(직접 최소
    // 재현으로 확認한 React act() 동작).
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e2::queued' } });
    });
    await waitForCondition(() => (nthLaneCell(1, 1)?.textContent ?? '').includes('병합카드'), '레인변경 trust_stage 병합');

    expect(nthLaneCell(1, 1)?.textContent).toContain('병합카드'); // e2 레인의 running(1) 칸.
    expect(nthLaneCell(1, 0)?.textContent).not.toContain('병합카드'); // 옛 queued(0) 칸엔 안 남음.
  });

  // 같은 클래스 — 컬럼 변경(bulk PATCH) 축도 동일 병합이 걸리는지 대칭 확認.
  it('컬럼 변경(bulk PATCH) 응답의 trust_stage를 병합한다', async () => {
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '병합카드2', status: 'backlog', priority: 'medium', epic_id: 'e1', trust_stage: 'queued' }],
      bulkPatchResponseData: [{ id: 's1', trust_stage: 'claimed_done' }],
    });
    const trustToggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '6단계 신뢰축 + 완료');
    await act(async () => { trustToggle!.click(); });

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e1::running' } });
    });
    await waitForCondition(() => (nthLaneCell(0, 3)?.textContent ?? '').includes('병합카드2'), '컬럼변경 trust_stage 병합');

    expect(nthLaneCell(0, 3)?.textContent).toContain('병합카드2'); // claimed_done(3) 칸 — 서버 응답값이 이겼다.
  });

  // ⚠️QA changes 10R HIGH②(카디르+codex, 2026-08-22) — bulk PATCH는 gate가 막은 항목도
  // HTTP200으로 반환하되 status는 기존값 유지+violation에 사유를 담는다(story #2521
  // PO확定②안). 형제(kanban-board)는 SSE가 결국 채워 정합시키지만 이 뷰엔 SSE가 없다 —
  // 응답의 진짜 status를 즉시 병합하지 않으면 gate 차단 낙관값이 영구 잔존한다(no-fiction).
  it('bulk PATCH가 gate 차단(violation)이면 낙관 status를 응답의 진짜 status로 되돌리고 경고를 띄운다', async () => {
    // 기본축(status, 5컬럼: backlog/ready-for-dev/in-progress/in-review/done) 기준 —
    // 위 nthLaneCell(7컬럼 트러스트축 전용)과 달리 이 테스트는 축 토글을 하지 않는다.
    function nthLaneCellStatusAxis(laneIndex: number, columnIndex: number): Element | undefined {
      const cells = [...container.querySelectorAll('div[class*="w-\\[220px\\]"]')];
      return cells[5 + laneIndex * 5 + columnIndex];
    }
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '차단카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      // gate가 in-progress 전이를 막아 status는 원래(backlog) 그대로 응답 — violation 동봉.
      bulkPatchResponseData: [{ id: 's1', status: 'backlog', violation: { reason: '워크플로우 위반' } }],
    });

    const handler = capturedDragEndHandlers.at(-1);
    await act(async () => {
      handler!({ active: { id: 's1' }, over: { id: 'e1::in-progress' } });
    });
    // 응답 병합 後 카드는 backlog(0) 칸으로 되돌아가고 in-progress(2) 칸엔 안 남는다.
    await waitForCondition(() => (nthLaneCellStatusAxis(0, 0)?.textContent ?? '').includes('차단카드'), 'gate 차단 status 되돌림');
    expect(nthLaneCellStatusAxis(0, 0)?.textContent).toContain('차단카드');
    expect(nthLaneCellStatusAxis(0, 2)?.textContent ?? '').not.toContain('차단카드');
    // 경고 토스트(형제 kanban-board와 동형 문구).
    expect(container.textContent).toContain('단계를 건너뛴 전이입니다');
  });
});

// ⚠️QA changes 10R HIGH③(카디르+codex, 2026-08-22) — StoryDetailPanel 배선 셋 미전달: 형제
// (kanban-board.tsx)는 tasks={storyTasks}(실 fetch)+members+onDeleteSuccess를 넘기는데 이
// 뷰는 tasks={[]} 하드코딩(실 fetch 없음)·members 미전달(담당자 편집 후보 0)·
// onDeleteSuccess 미전달(ghost 카드)이었다 — 카드 클릭할 때마다 매번 발생하는 결함이라
// 최우선 처방.
describe('EpicSwimlaneBoard — StoryDetailPanel 배선(story #2931, QA changes 10R HIGH③)', () => {
  it('카드를 클릭하면 실제로 /api/tasks를 불러 Tasks 탭에 반영한다(하드코딩된 tasks=[] 아님)', async () => {
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '패널카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      tasksByStoryId: { s1: [{ id: 't1', title: '실제태스크', status: 'in-progress' }] },
    });
    const card = container.querySelector('[title="패널카드"]') as HTMLElement;
    expect(card, '카드를 못 찾음').not.toBeNull();
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForCondition(() => container.textContent?.includes('실제태스크') ?? false, 'StoryDetailPanel 실 tasks fetch');
    expect(container.textContent).toContain('Tasks (1)'); // 하드코딩 tasks=[]였다면 항상 (0).
    expect(container.textContent).toContain('실제태스크');
  });

  it('members가 전달돼 담당자 편집 후보가 0명이 아니다', async () => {
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '패널카드2', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      members: [{ id: 'm1', name: '담당자후보' }],
    });
    const card = container.querySelector('[title="패널카드2"]') as HTMLElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForCondition(() => container.textContent?.includes('패널카드2') ?? false, '패널 오픈');

    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('편집'));
    expect(editBtn, '담당자 편집 버튼을 못 찾음').toBeDefined();
    await act(async () => { editBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain('담당자후보'); // members=[] 하드코딩이었다면 후보 0명.
  });

  it('onDeleteSuccess가 전달돼 삭제 성공 시 보드에서 카드가 실제로 사라진다(ghost 카드 아님)', async () => {
    let deletedId: string | null = null;
    await mount({
      epics: [{ id: 'e1', title: '에픽', status: 'active', position: 1 }],
      stories: [{ id: 's1', title: '삭제될카드', status: 'backlog', priority: 'medium', epic_id: 'e1' }],
      deleteStorySpy: (id) => { deletedId = id; },
    });
    const card = container.querySelector('[title="삭제될카드"]') as HTMLElement;
    await act(async () => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForCondition(() => container.textContent?.includes('삭제될카드') ?? false, '패널 오픈');

    const deleteTrigger = container.querySelector('[aria-label="스토리 삭제"]') as HTMLElement;
    expect(deleteTrigger, '삭제 트리거를 못 찾음').not.toBeNull();
    await act(async () => { deleteTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Dialog는 document.body에 포탈되므로 container가 아닌 document 전체에서 찾는다.
    const confirmBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === '영구 삭제');
    expect(confirmBtn, '삭제 확인 버튼을 못 찾음').toBeDefined();
    await act(async () => { confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    await waitForCondition(() => deletedId === 's1', 'DELETE 호출 발화');
    await waitForCondition(() => !(container.textContent?.includes('삭제될카드') ?? false), '삭제 후 카드 실종(onDeleteSuccess 배선)');
    expect(container.textContent).not.toContain('삭제될카드');
  });
});
