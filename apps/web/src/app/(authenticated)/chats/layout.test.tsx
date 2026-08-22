// @vitest-environment jsdom
//
// story #2921 S1(D04 처방 골격) — 영구 스플릿뷰 shell 회귀가드. ChatListView 내부(SSE·fetch
// 등)는 자기 테스트(chat-list-view.test.tsx)가 이미 잰다 — 여기는 이 layout이 실제로 잰다고
// «주장»하는 것(①ChatListView 단일 마운트 ②경로별 반응형 클래스 토글 ③새 대화 버튼 배선)만
// 좁게 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import ChatsLayout from './layout';

const useDashboardContextMock = vi.fn();
vi.mock('../../dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

const usePathnameMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

// story #2921 — ChatListView 자체 로직(SSE·fetch·모달 내부)은 스코프 밖. open/onOpenChange를
// 그대로 받는지만 확認하는 얕은 스텁.
vi.mock('@/components/chat/chat-list-view', () => ({
  ChatListView: ({ open }: { open?: boolean }) => (
    <div data-testid="chat-list-view">chat-list-view(open={String(open)})</div>
  ),
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
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1', projectId: 'proj-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('ChatsLayout — story #2921 S1(영구 스플릿뷰 shell)', () => {
  it('ChatListView는 정확히 1곳만 마운트된다(리스트 경로·대화 경로 둘 다 — 이중 구독 방지가 이 story의 핵심 근거)', async () => {
    usePathnameMock.mockReturnValue('/chats');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div>children</div></ChatsLayout>));
    });
    expect(container.querySelectorAll('[data-testid="chat-list-view"]')).toHaveLength(1);
  });

  it('/chats(리스트 경로) — 레일은 모바일에서도 보이고(lg 무관 flex), outlet은 모바일에서 숨는다(hidden)', async () => {
    usePathnameMock.mockReturnValue('/chats');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div data-testid="outlet-content">outlet</div></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    const outlet = container.querySelector('[data-testid="chat-outlet"]');
    expect(rail?.className).toContain('flex');
    expect(rail?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(outlet?.className).toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('/chats/[id](대화 경로) — outlet은 모바일에서도 보이고, 레일은 모바일에서 숨는다(현행 라우트 전환 유지)', async () => {
    usePathnameMock.mockReturnValue('/chats/conv-123');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div data-testid="outlet-content">outlet</div></ChatsLayout>));
    });
    const rail = container.querySelector('[data-testid="chat-rail"]');
    const outlet = container.querySelector('[data-testid="chat-outlet"]');
    expect(rail?.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(outlet?.className).toContain('flex');
    expect(outlet?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('두 경로 다 lg:flex(데스크톱 항상 병렬)를 갖는다 — 반응형 토글은 모바일 전용', async () => {
    for (const pathname of ['/chats', '/chats/conv-123']) {
      usePathnameMock.mockReturnValue(pathname);
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await act(async () => {
        root.render(wrap(<ChatsLayout><div data-testid="outlet-content">outlet</div></ChatsLayout>));
      });
      const rail = container.querySelector('[data-testid="chat-rail"]');
      const outlet = container.querySelector('[data-testid="chat-outlet"]');
      expect(rail?.className).toContain('lg:flex');
      expect(outlet?.className).toContain('lg:flex');
    }
  });

  it('「새 대화」버튼 클릭 시 ChatListView에 open=true가 전달된다(모달 배선 회귀 0)', async () => {
    usePathnameMock.mockReturnValue('/chats');
    await act(async () => {
      root.render(wrap(<ChatsLayout><div>children</div></ChatsLayout>));
    });
    expect(container.querySelector('[data-testid="chat-list-view"]')!.textContent).toContain('open=false');
    const newConvBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('새 대화') || b.textContent?.includes('New'));
    expect(newConvBtn).toBeTruthy();
    await act(async () => { newConvBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[data-testid="chat-list-view"]')!.textContent).toContain('open=true');
  });
});
