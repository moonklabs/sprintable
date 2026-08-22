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
};

// ⚠️QA changes 4R(PR#3377, 카디르+codex, 2026-08-22) — CI 실행 명령까지 정확 재현해 8+1회
// 전부 green(로컬 재현 실패) — CI 전용·같은 2건(둘 다 bulk 경로) 3연속. 재현 못 하는 실패는
// 흔적을 남기는 수밖에 없다 — 모든 fetch 호출을 순서대로 기록해, waitFor가 결국 timeout나면
// 그 로그를 에러 메시지에 실어 「bulk가 아예 안 불림(환경/로직 차)」 vs 「늦게 불림(순수
// 지연)」을 CI 로그만으로 갈라준다(페드루 의심 — 순수 지연이면 레인 테스트도 가끔 튀어야
// 하는데 항상 bulk 2건만이라 결정론적 환경 차 가능성).
let callLog: string[] = [];

function stubFetch({ stories = [], epics = [], members = [], bulkPatchSpy, singlePatchSpy, singlePatchOk = true, bulkPatchOk = true, storiesGetSpy }: FetchStub) {
  callLog = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    callLog.push(`${init?.method ?? 'GET'} ${url}`);
    if (typeof url === 'string' && url.startsWith('/api/stories/bulk') && init?.method === 'PATCH') {
      bulkPatchSpy?.(JSON.parse(init.body ?? '{}'));
      if (!bulkPatchOk) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (typeof url === 'string' && /^\/api\/stories\/[^/]+$/.test(url) && init?.method === 'PATCH') {
      const id = url.split('/').pop()!;
      singlePatchSpy?.(id, JSON.parse(init.body ?? '{}'));
      if (!singlePatchOk) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return { ok: true, json: async () => ({ data: {} }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      storiesGetSpy?.();
      return { ok: true, json: async () => ({ data: stories }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/goals?')) {
      return { ok: true, json: async () => ({ data: epics }) };
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
});
