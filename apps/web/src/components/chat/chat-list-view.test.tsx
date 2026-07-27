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

// use-chat-sse는 EventSource(jsdom 미구현)를 쓰므로 no-op으로 목.
vi.mock('@/hooks/use-chat-sse', () => ({
  useChatSse: () => {},
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
