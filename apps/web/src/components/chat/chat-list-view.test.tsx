// @vitest-environment jsdom
//
// story #2168 PR-② — "다른 프로젝트" 섹션(현재 프로젝트 밖 최근 대화, BE
// GET /conversations/recent-outside-project). AC②(현재 목록 아래 구분 섹션)·③(프로젝트명
// 병기)·④(누르면 `?p=`+`from=`+`pn=`을 실은 URL로 이동 — R2 SSOT가 헤더/스위처 전환을
// 대신 처리하므로 여기선 그 URL을 정확히 만드는지만 고정한다) 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';

const { useDashboardContextMock, pushMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

// use-chat-sse는 EventSource(jsdom 미구현)를 쓰므로 no-op으로 목 — 단, story #1978은 정확히
// onReconnect 배선을 검증해야 하니 마지막 호출의 옵션을 캡처해 테스트에서 직접 불러낸다
// (SSE 백오프/타이머 전체를 재현하지 않는다 — sse-multiplexer.test.tsx가 이미 그 축은
// "실제 재연결 타이밍은 별도"로 선언하고 옵션 배선만 고정하는 동일 관례).
const { useChatSseMock } = vi.hoisted(() => ({ useChatSseMock: vi.fn() }));
vi.mock('@/hooks/use-chat-sse', () => ({
  useChatSse: (opts: unknown) => { useChatSseMock(opts); },
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  useChatSseMock.mockClear();
  useDashboardContextMock.mockReturnValue({ role: 'member' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function stubFetch(outsideProject: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) {
      return { ok: true, json: async () => ({ data: outsideProject }) };
    }
    if (url.includes('/api/conversations?')) {
      return { ok: true, json: async () => ({ data: [], total: 0 }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

// story #1978 — /api/conversations? 호출 횟수만 센다(목록 백필 재fetch가 실제로 일어났는지).
// /api/conversations/recent-outside-project는 별개 축(마운트 1회 전용, 이 스토리 스코프 밖)이라 안 센다.
function countMyConversationsFetchCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => (url as string).includes('/api/conversations?') && !(url as string).includes('recent-outside-project')).length;
}

async function mount() {
  await act(async () => {
    root.render(wrap(<ChatListView projectId="proj-current" currentTeamMemberId="me-1" />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const OUTSIDE_CONV = {
  id: 'conv-outside-1',
  type: 'dm',
  title: '댄군과의 대화',
  project_id: 'proj-content',
  project_name: 'sprintable-content',
  project_slug: 'sprintable-content',
};

describe('ChatListView — 다른 프로젝트 섹션 (story #2168 PR-②)', () => {
  it('BE가 항목을 주면 "다른 프로젝트" 섹션이 렌더되고 프로젝트명이 병기된다(AC②③)', async () => {
    stubFetch([OUTSIDE_CONV]);
    await mount();
    expect(container.textContent).toContain('다른 프로젝트');
    expect(container.textContent).toContain('댄군과의 대화');
    expect(container.textContent).toContain('sprintable-content');
  });

  it('BE가 빈 배열을 주면 섹션 자체가 조용히 안 보인다(완전분리도 소음도 아닌 세 번째 선택)', async () => {
    stubFetch([]);
    await mount();
    expect(container.textContent).not.toContain('다른 프로젝트');
  });

  it('항목을 누르면 대상 프로젝트(p)·원 프로젝트(from)·표시용 프로젝트명(pn)을 실은 URL로 이동한다(AC④)', async () => {
    stubFetch([OUTSIDE_CONV]);
    await mount();
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('댄군과의 대화'));
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(pushMock).toHaveBeenCalledTimes(1);
    const dest = pushMock.mock.calls[0]?.[0] as string;
    expect(dest.startsWith('/chats/conv-outside-1?')).toBe(true);
    const params = new URLSearchParams(dest.split('?')[1]);
    expect(params.get('p')).toBe('proj-content');
    expect(params.get('from')).toBe('proj-current');
    expect(params.get('pn')).toBe('sprintable-content');
  });

  // 라이브 실측으로 발견(2026-07-27) — 클릭 직후 router.push가 이 컴포넌트 자체를 언마운트시켜,
  // 로컬 useToast()로 띄운 토스트가 화면에 페인트될 새도 없이 사라졌었다. queuePendingToast로
  // sessionStorage에 넘겨 네비게이션을 넘어 살아남게 한다(cross-project-toast-provider.tsx가 소비).
  it('클릭 시 로컬 토스트가 아니라 sessionStorage 경유 queuePendingToast로 메시지를 넘긴다(네비게이션 생존)', async () => {
    stubFetch([OUTSIDE_CONV]);
    sessionStorage.clear();
    await mount();
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('댄군과의 대화'));
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(sessionStorage.getItem('sprintable_pending_toast')).toBe('sprintable-content 프로젝트로 이동');
  });
});

// story #1978(트랙C) — SSE 드롭 후 놓친 conversation.message_created가 목록에 미백필되던
// 두 구멍(재연결·백그라운드 복귀)을 고정한다. useChatSse는 위에서 옵션 캡처용으로만 목했으므로
// 실제 SSE 백오프/타이머는 재현하지 않는다 — onReconnect 콜백이 넘어왔는지, 그리고 그 콜백을
// 직접 불렀을 때 실제로 재fetch가 도는지만 검증한다(배선 고정).
describe('ChatListView — SSE 재연결·백그라운드 복귀 재fetch (story #1978)', () => {
  it('useChatSse에 onReconnect가 넘어가고, 그걸 부르면 목록이 재fetch된다(AC①)', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onReconnect?: () => void } | undefined;
    expect(typeof opts?.onReconnect).toBe('function');
    await act(async () => { opts!.onReconnect!(); });
    await act(async () => { await Promise.resolve(); });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount + 1);
  });

  it('탭이 백그라운드에서 복귀(visibilitychange, hidden=false)하면 목록이 재fetch된다(AC①)', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await Promise.resolve(); });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount + 1);
  });

  it('탭이 백그라운드로 갈 때(hidden=true)는 재fetch하지 않는다(불필요 호출 억제, AC③)', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await Promise.resolve(); });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount);
  });
});

// story #2938(유나 design 처방·WCAG 실측 2026-08-23) — unread count 배지가 bg-primary(solid)+
// text-primary-foreground(white)라 소형 텍스트 AA 미달(다크 3.21). bg-proof-blue-soft+
// text-foreground로 교정(라이트 16.13/다크 13.94) — 전역 badge.tsx 무접촉, 이 usage만.
describe('ChatListView — unread count 배지 대비 교정(story #2938)', () => {
  function stubFetchWithUnread(unreadCount: number) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('/api/conversations?')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'conv-1', type: 'dm', title: '읽지 않은 대화', unread_count: unreadCount }],
            total: 1,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => null };
    }));
  }

  it('unread>0이면 배지가 bg-proof-blue-soft+text-foreground로 뜬다(bg-primary 잔존 0)', async () => {
    stubFetchWithUnread(3);
    await mount();
    const badge = [...container.querySelectorAll('span')].find((s) => s.textContent === '3');
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('bg-proof-blue-soft');
    expect(badge!.className).toContain('text-foreground');
    expect(badge!.className).not.toContain('bg-primary');
    expect(badge!.className).not.toContain('text-primary-foreground');
  });
});
