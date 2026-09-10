'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * story #2921 S6(P0-C, 챗 리디자인 시안 §S6 — 유나 확定 2026-08-22) — 우측 슬롯(ReadingPanel)이
 * 열렸을 때 좁은 데스크톱(lg~xl 사이, 1024~1279px)에서 rail(270px)+main+reading(480px 최소)이
 * 동시에 눌려 main이 300px 밑으로 떨어지는 문제의 처방. 리스트 레일(layout.tsx)과 우측 슬롯
 * (chat-view.tsx)은 서로 다른 컴포넌트라 "지금 reading이 열려 있는지"를 끌어올려야(lift) 한다.
 *
 * 규칙(유나 확定, 산수 근거):
 * ① xl(1280px)↑ — 3-pane 항상 나란히(rail 270+main 530+reading 480). rail은 절대 안 접힘.
 * ② 1024~1279px, reading 닫힘 — 현행 2-pane(rail+main) 그대로, 무변화.
 * ③ 1024~1279px, reading 열림 — rail 자동 접힘(main 544 보장), reading은 clamp 아니라 480 고정.
 * ④ 접힌 rail은 토글로 다시 부를 수 있다 — 그땐 모바일과 동형인 오버레이(main/reading을
 *    다시 눌러 앉히지 않고 그 위를 덮는다).
 *
 * ⛔Thread 패널(w-80=320px 고정)은 이 규칙 대상이 아니다 — reading(480)보다 훨씬 좁아 같은
 * 폭에서 눌림이 덜하고, 유나 확定 문구도 "Reading 열림"만 명시했다(임의 확장 안 함).
 */
export type ChatRailMode = 'normal' | 'collapsed' | 'overlay';

interface ChatRailContextValue {
  /** normal=평소 flex 흐름 그대로 보임·collapsed=완전히 숨음·overlay=토글로 다시 부른 상태
   * (main/reading 폭을 안 건드리고 그 위를 덮는다, 모바일 드로어와 동형). */
  railMode: ChatRailMode;
  toggleManualExpand: () => void;
  /** ChatView가 ReadingPanel 열림 여부를 보고한다. */
  setReadingOpen: (open: boolean) => void;
  /** story #3788(B-③, 유나 定 2026-09-10 카드 착지) — 좌측 레일(`ChatListView`)이 "내 대화"
   * 목록 로드 상태를 여기로 끌어올린다(lift, docs `DocsLayoutContext`와 같은 자리). 우측
   * outlet(`chats/page.tsx`)이 이 둘로 로딩·0건·있음 세 갈래를 가른다 — "대화가 없습니다"
   * (왼쪽)와 "선택하세요"(오른쪽)가 동시에 서는 모순(두 세계 동시 진술)을 막는다. */
  conversationsLoading: boolean;
  setConversationsLoading: (value: boolean) => void;
  conversationCount: number;
  setConversationCount: (value: number) => void;
  /** story #3788(B-③ 후속, 페드루 그라운딩 2026-09-10 10:43Z) — 좌측 레일에는 "내 대화"·
   * "에이전트" 두 탭이 있고 `conversationsLoading`/`conversationCount`는 **지금 보이는 탭**의
   * 값이어야 한다(안 보이는 탭의 0/N은 우측과 모순을 만들지 않는다 — my 0건이어도 사용자가
   * 에이전트 탭을 보고 있고 거기 N건이 있으면 「없다」고 말하면 안 된다). */
  activeList: 'my' | 'agent';
  setActiveList: (value: 'my' | 'agent') => void;
  /** story #3790(유나 定 2026-09-10) — 활성 탭의 목록 fetch가 실패했음을 끌어올린다.
   * 로딩·실패·0건 세 세계를 좌우가 같은 낱말로 말하게 한다(story #3784와 같은 축) —
   * 0건 판정보다 먼저 봐야 「실패」가 「없다」로 오독되지 않는다. */
  conversationsLoadError: boolean;
  setConversationsLoadError: (value: boolean) => void;
  /** 우측 outlet(`chats/page.tsx`)의 재시도 버튼이 부른다 — 실제 재조회는 좌측 레일
   * (`ChatListView`)의 활성 탭 로더가 쥐고 있으므로 그 함수 자체를 끌어올린다. */
  retryConversations: () => void;
  setRetryConversations: (fn: () => void) => void;
}

const ChatRailContext = createContext<ChatRailContextValue | null>(null);

export function ChatRailProvider({ children }: { children: ReactNode }) {
  const [readingOpen, setReadingOpenState] = useState(false);
  const [isBelowXl, setIsBelowXl] = useState(false);
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  // ChatListView의 초기 loading 상태(true)와 짝을 맞춘다 — 첫 렌더에서 "0건"으로 잘못
  // 단정하지 않는다.
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationCount, setConversationCount] = useState(0);
  const [activeList, setActiveList] = useState<'my' | 'agent'>('my');
  const [conversationsLoadError, setConversationsLoadError] = useState(false);
  // 함수 값 자체를 state로 들고 있으려면 setState에 팩토리 형(() => fn)으로 넘겨야 한다
  // (그냥 fn을 넘기면 React가 "updater 함수"로 오인해 즉시 호출한다) — setRetryConversations는
  // 그 함정을 감싸는 얇은 래퍼.
  const [retryConversations, setRetryConversationsState] = useState<() => void>(() => () => {});
  const setRetryConversations = useCallback((fn: () => void) => {
    setRetryConversationsState(() => fn);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1279px)');
    const update = () => setIsBelowXl(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // reading이 닫히는 "전환"에서만 수동 펼침도 같이 리셋한다 — 다음에 reading이 다시 열리면
  // 자동접힘부터 재시작(닫힌 채로 남아있던 수동 펼침이 다음 무관한 세션까지 새 나가지 않게).
  // setReadingOpen(이벤트 기반 콜백) 안에서 처리해 렌더 효과(useEffect) 안 setState 연쇄를
  // 피한다(react-hooks/set-state-in-effect).
  const setReadingOpen = useCallback((open: boolean) => {
    setReadingOpenState((prev) => {
      if (prev && !open) setManuallyExpanded(false);
      return open;
    });
  }, []);

  const railMode: ChatRailMode = !isBelowXl || !readingOpen
    ? 'normal'
    : manuallyExpanded ? 'overlay' : 'collapsed';

  const toggleManualExpand = useCallback(() => setManuallyExpanded((v) => !v), []);

  const value = useMemo(
    () => ({
      railMode, toggleManualExpand, setReadingOpen,
      conversationsLoading, setConversationsLoading,
      conversationCount, setConversationCount,
      activeList, setActiveList,
      conversationsLoadError, setConversationsLoadError,
      retryConversations, setRetryConversations,
    }),
    [
      railMode, toggleManualExpand, setReadingOpen, conversationsLoading, conversationCount, activeList,
      conversationsLoadError, retryConversations, setRetryConversations,
    ],
  );

  return <ChatRailContext.Provider value={value}>{children}</ChatRailContext.Provider>;
}

export function useChatRail(): ChatRailContextValue {
  const ctx = useContext(ChatRailContext);
  if (!ctx) throw new Error('useChatRail must be used within ChatRailProvider');
  return ctx;
}

/** story #3788 — `ChatListView`는 격리 단위테스트에서 `ChatRailProvider` 없이 단독 렌더되는
 * 자리가 있다(chat-list-view.test.tsx). Provider 밖이면 null을 돌려주는 논-throw 버전 —
 * `setConversationsLoading`/`setConversationCount` 호출부는 null이면 조용히 스킵한다(story
 * #3759 useToast() 그레이스풀 폴백과 동형 — 무관한 기존 테스트를 강제로 안 건드리면서
 * 프로덕션(Provider 항상 有)에선
 * 원 기능 그대로 작동). */
export function useChatRailOptional(): ChatRailContextValue | null {
  return useContext(ChatRailContext);
}
