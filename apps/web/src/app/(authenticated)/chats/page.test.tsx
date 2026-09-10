// @vitest-environment jsdom
//
// story #3788(B-③, 유나 定) — 우측 outlet(chats/page.tsx)이 ChatRailContext의
// conversationsLoading/conversationCount로 로딩·0건·있음 세 갈래를 정확히 가르는지 확認.
// 핵심 축: 대화 0건일 때 「선택하세요」류 문구가 **0**이어야 한다(고를 게 없는데 고르라는
// 모순 방지 — 왼쪽 레일의 「대화가 없습니다」와 같은 낱말만 서야 함).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import ChatsPage from './page';
import { ChatRailProvider, useChatRail } from './chat-rail-context';
import { TopBarProvider } from '@/components/nav/top-bar-context';

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

// layout.test.tsx의 ReadingOpenProbe와 같은 형 — 실 ChatListView(SSE·fetch)는 이 파일
// 스코프 밖, 이 파일은 outlet이 context 값을 정확히 읽어 가르는지만 잰다.
function StateProbe({
  loading, count, error, onRetry,
}: { loading: boolean; count: number; error?: boolean; onRetry?: () => void }) {
  const { setConversationsLoading, setConversationCount, setConversationsLoadError, setRetryConversations } = useChatRail();
  useEffect(() => {
    setConversationsLoading(loading);
    setConversationCount(count);
    setConversationsLoadError(error ?? false);
    if (onRetry) setRetryConversations(onRetry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, count, error, onRetry, setConversationsLoading, setConversationCount, setConversationsLoadError]);
  return null;
}

function renderPage(loading: boolean, count: number, error?: boolean, onRetry?: () => void) {
  return wrap(
    <TopBarProvider>
      <ChatRailProvider>
        <StateProbe loading={loading} count={count} error={error} onRetry={onRetry} />
        <ChatsPage />
      </ChatRailProvider>
    </TopBarProvider>,
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ChatsPage — story #3788(B-③) 세 갈래', () => {
  it('로딩 中(아직 모름) — EmptyState를 아예 안 그린다(3784와 같은 형)', async () => {
    await act(async () => { root.render(renderPage(true, 0)); });
    expect(container.textContent).not.toContain(koMessages.chats.noConversations);
    expect(container.textContent).not.toContain(koMessages.chats.selectConversationPrompt);
  });

  it('⭐대화 0건 — 왼쪽 레일과 같은 낱말(noConversations)만 서고, 「선택하세요」류는 0회', async () => {
    await act(async () => { root.render(renderPage(false, 0)); });
    expect(container.textContent).toContain(koMessages.chats.noConversations);
    expect(container.textContent).not.toContain(koMessages.chats.selectConversationPrompt);
  });

  it('대화 있음·미선택 — selectConversationPrompt만 서고 noConversations는 0회', async () => {
    await act(async () => { root.render(renderPage(false, 3)); });
    expect(container.textContent).toContain(koMessages.chats.selectConversationPrompt);
    expect(container.textContent).not.toContain(koMessages.chats.noConversations);
  });

  it('구역 이름("채팅")을 EmptyState 제목에 재사용하지 않는다(TopBarSlot은 별도 슬롯 — 이 트리엔 렌더 안 됨)', async () => {
    await act(async () => { root.render(renderPage(false, 3)); });
    const emptyStateTitle = container.querySelector('h3');
    expect(emptyStateTitle?.textContent).not.toBe(koMessages.chats.title);
    expect(emptyStateTitle?.textContent).toBe(koMessages.chats.selectConversationPrompt);
  });
});

// story #3790(유나 定) — 판단 순서는 로딩 → 실패 → 0건. 실패했을 때 목록이 비어 있으므로
// (count===0), 0건 검사가 먼저 서면 실패가 「없다」로 떨어진다 — 그 순서 자체를 고정한다.
describe('ChatsPage — story #3790 실패 축', () => {
  it('⭐실패 — count===0이어도 noConversations가 아니라 conversationsLoadFailed를 말한다', async () => {
    await act(async () => { root.render(renderPage(false, 0, true)); });
    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).not.toContain(koMessages.chats.noConversations);
    expect(container.textContent).not.toContain(koMessages.chats.selectConversationPrompt);
  });

  it('실패 — count>0이어도(활성 탭 것이 실패한 것이므로) 여전히 실패를 말한다', async () => {
    await act(async () => { root.render(renderPage(false, 5, true)); });
    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).not.toContain(koMessages.chats.selectConversationPrompt);
  });

  it('재시도 버튼이 ChatRailContext의 retryConversations를 그대로 부른다', async () => {
    const onRetry = vi.fn();
    await act(async () => { root.render(renderPage(false, 0, true, onRetry)); });
    const retryBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.retry);
    expect(retryBtn).not.toBeUndefined();
    await act(async () => { retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
