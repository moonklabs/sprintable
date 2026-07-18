'use client';

import { useEffect, useRef, useState } from 'react';
import { useChatSse } from './use-chat-sse';

/**
 * story #1977(트랙B) — GNB 채팅 unread 총합(3번째 표면: 데스크톱 사이드바 채팅 항목 +
 * 모바일 4탭 채팅 탭, 유나 시안 768e89b5 v2 ③). `/api/conversations/unread-count`(story #1992,
 * caller 전 참여 대화 unread_count SUM)를 서버 truth로 삼는다.
 *
 * mount 시 1회 fetch + `conversation.read` SSE(#1976, 본인 타 커넥션 전파)로 다른 탭/기기에서
 * mark-read 시 자가정정 — mark-read를 호출한 그 화면(chat-view.tsx)은 자신의 SSE 커넥션에는
 * 에코되지 않으므로, 사이드바/탭바가 별도 커넥션으로 그 이벤트를 받아 갱신한다. `conversation.
 * message_created`(신규 메시지 수신 — SSE는 실 참여자에게만 전달되므로 항상 +1 정확)는 낙관
 * 증분. mobile-tab-bar.tsx의 기존 pendingCount(마운트 1회 fetch+focus 재조회) 패턴과 동일
 * 구조(단일 effect·로컬 async 함수)로 맞췄다.
 */
export function useChatUnreadTotal(currentTeamMemberId?: string): number {
  const [total, setTotal] = useState(0);
  const fetchTotalRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchTotal() {
      try {
        const res = await fetch('/api/conversations/unread-count');
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { count?: number };
        if (!cancelled) setTotal(json.count ?? 0);
      } catch {
        /* non-critical — 다음 트리거(SSE/visibility)에서 재시도 */
      }
    }
    fetchTotalRef.current = () => void fetchTotal();

    void fetchTotal();
    const handleVisibility = () => {
      if (!document.hidden) void fetchTotal();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);

    return () => {
      cancelled = true;
      fetchTotalRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
    };
  }, []);

  useChatSse({
    currentTeamMemberId,
    onConversationMessage: () => setTotal((prev) => prev + 1),
    onConversationRead: () => fetchTotalRef.current?.(),
  });

  return total;
}
