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
}

const ChatRailContext = createContext<ChatRailContextValue | null>(null);

export function ChatRailProvider({ children }: { children: ReactNode }) {
  const [readingOpen, setReadingOpenState] = useState(false);
  const [isBelowXl, setIsBelowXl] = useState(false);
  const [manuallyExpanded, setManuallyExpanded] = useState(false);

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
    () => ({ railMode, toggleManualExpand, setReadingOpen }),
    [railMode, toggleManualExpand, setReadingOpen],
  );

  return <ChatRailContext.Provider value={value}>{children}</ChatRailContext.Provider>;
}

export function useChatRail(): ChatRailContextValue {
  const ctx = useContext(ChatRailContext);
  if (!ctx) throw new Error('useChatRail must be used within ChatRailProvider');
  return ctx;
}
