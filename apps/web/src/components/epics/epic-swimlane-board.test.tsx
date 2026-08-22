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
};

function stubFetch({ stories = [], epics = [], members = [], bulkPatchSpy, singlePatchSpy }: FetchStub) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (typeof url === 'string' && url.startsWith('/api/stories/bulk') && init?.method === 'PATCH') {
      bulkPatchSpy?.(JSON.parse(init.body ?? '{}'));
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (typeof url === 'string' && /^\/api\/stories\/[^/]+$/.test(url) && init?.method === 'PATCH') {
      const id = url.split('/').pop()!;
      singlePatchSpy?.(id, JSON.parse(init.body ?? '{}'));
      return { ok: true, json: async () => ({ data: {} }) };
    }
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
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

async function mount(stub: FetchStub) {
  stubFetch(stub);
  await act(async () => {
    root.render(withIntl(<EpicSwimlaneBoard projectId="p1" />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
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
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
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
      handler!({ active: { id: 's1' }, over: { id: 'e1::needs_input' } });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(anyPatchCalled).toBe(false);
  });
});
