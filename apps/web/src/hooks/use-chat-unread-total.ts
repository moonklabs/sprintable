'use client';

import { useEffect, useRef, useState } from 'react';
import { isOwnMessage, useChatSse } from './use-chat-sse';
import { fetchChatUnreadTotal } from '@/lib/chat-unread-total-client';
import { useSseMultiplexerContext } from '@/components/realtime-provider';

/**
 * story 4876 — a message event is NOT always «one more unread». The server number (the fetch) and the SSE stream are two views of the same
 * messages: on the FIRST connect the server replays the person's still-pending events (`is_backfill: true`, events.py `_BACKFILL_INITIAL_EVENTS`) —
 * messages that arrived while nobody was connected, which the fetch already counts. `prev + 1` for each of them showed 4 unread on a server that had 2
 * (measured on dev, both phones: fetch `count:2` and two replayed `conversation.message_created` landed in the same tick). The same double count
 * happens when a live event arrives while the first fetch is out (its answer may or may not include it), and an event before any server number
 * is known would count from 0. In those cases the event only means «the number changed» — ask the server again (one shared recount for every badge
 * on the screen, sent once the events go quiet) instead of adding 1. A live event with a server number in hand keeps the instant +1. A request that fails
 * leaves no number we can trust, so the next event asks again instead of adding to a stale one.
 * Known, older and not changed here: nothing in this hook starts over when the organization is switched (the shell's automatic switch raises `bumpOrgSyncVersion()`, the manual switcher
 * `use-unified-switcher.ts` → `router.refresh()` raises nothing), so the badge keeps the old organization's number until the next read, reconnect or focus recount — before and after story 4876.
 */
const RECOUNT_QUIET_MS = 250;
const RECOUNT_MAX_WAIT_MS = 1500; // a steady stream of events still gets a recount within this long of the burst's first event
const refetchers = new Set<() => void>();
let recountTimer: ReturnType<typeof setTimeout> | null = null;
let recountFirstAt = 0;
function scheduleServerRecount(): void {
  const now = Date.now();
  if (recountTimer) {
    clearTimeout(recountTimer); // trailing edge: the burst is not over yet
  } else {
    recountFirstAt = now;
  }
  // wait for quiet, but never past the ceiling counted from the first event of this burst
  const wait = Math.min(RECOUNT_QUIET_MS, Math.max(0, recountFirstAt + RECOUNT_MAX_WAIT_MS - now));
  recountTimer = setTimeout(() => {
    recountTimer = null;
    // every badge asks inside one dispatch, so the shared request (fetchChatUnreadTotal · fresh) goes out once
    for (const run of [...refetchers]) run();
  }, wait);
}

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
  // story 4876 — do we hold a server number yet, and is a request for it out right now
  const haveServerCountRef = useRef(false);
  const requestsOutRef = useRef(0);
  const mux = useSseMultiplexerContext();
  const muxRef = useRef(mux);
  useEffect(() => { muxRef.current = mux; }, [mux]);

  useEffect(() => {
    let cancelled = false;
    async function fetchTotal(fresh = false) {
      // story #4263 AC1 — 공용 요청(진행 중이면 합류): 이 훅이 한 화면에 여럿 마운트돼도 같은 순간 1번(fetchWithAuth · 401 처리는 그 안).
      // ① 이벤트가 부른 재조회(fresh)는 이벤트 전에 뜬 요청에 합류하지 않는다.
      requestsOutRef.current += 1;
      const count = await fetchChatUnreadTotal({ fresh });
      requestsOutRef.current -= 1;
      if (cancelled) return;
      if (count !== null) { haveServerCountRef.current = true; setTotal(count); }
      else haveServerCountRef.current = false; // a failed request: the number on screen may be stale — the next event asks again instead of adding 1
    }
    fetchTotalRef.current = () => void fetchTotal(true); // SSE 이벤트(conversation.read · 재연결)용
    const recount = () => void fetchTotal(true);
    refetchers.add(recount);

    void fetchTotal();
    const handleVisibility = () => {
      if (document.hidden) return;
      // story #4263 AC2 — SSE가 살아 있으면(4252와 같은 판정 · mux.isAlive) 이 수는 SSE가 이미 따라가고 있다(message_created 낙관 +1 ·
      // conversation.read 재조회) — 포커스 재조회를 생략한다. 죽었거나 끊겼던 뒤엔 재조회(정확성 우선 · 재연결은 onReconnect가 따로 스냅).
      if (muxRef.current?.isAlive()) return;
      void fetchTotal();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);

    return () => {
      cancelled = true;
      fetchTotalRef.current = null;
      refetchers.delete(recount);
      if (refetchers.size === 0 && recountTimer) { clearTimeout(recountTimer); recountTimer = null; } // the last badge is gone: nobody to recount for
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
    };
  }, []);

  useChatSse({
    // story #4440 — my own message (now echoed to my other tabs) is never unread
    onConversationMessage: (payload) => {
      if (isOwnMessage(payload, currentTeamMemberId)) return;
      // story 4876 — a replayed event (is_backfill), an event with no server number yet, or one that lands while a request is out only says
      // «the number changed»: take the server's number, never prev + 1 (the fetch may already count it)
      if (payload.is_backfill === true || !haveServerCountRef.current || requestsOutRef.current > 0) { scheduleServerRecount(); return; }
      setTotal((prev) => prev + 1);
    },
    onConversationRead: () => fetchTotalRef.current?.(),
    // story #1978(트랙C) — SSE 드롭 중 놓친 conversation.message_created는 낙관 +1이 못 따라오니
    // 재연결 시 서버 truth로 스냅해 drift를 없앤다. visibility/focus(위)는 이미 있었지만 그건
    // "탭이 백그라운드였다 포그라운드로" 축이고, 이건 "SSE 커넥션 자체가 끊겼다 재연결됐다"
    // 축이라 서로 다른 트리거다(탭은 계속 보이는데 네트워크만 끊겼다 복구된 경우 visibility는
    // 안 fire하지만 onReconnect는 fire한다).
    onReconnect: () => fetchTotalRef.current?.(),
  });

  return total;
}
