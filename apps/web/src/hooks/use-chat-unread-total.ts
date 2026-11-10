'use client';

import { useEffect, useRef, useState } from 'react';
import { isOwnMessage, useChatSse } from './use-chat-sse';
import { fetchChatUnreadTotal } from '@/lib/chat-unread-total-client';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { getEffectiveOrgId } from '@/lib/project-context-client';

/**
 * story 4876 — a message event is NOT always «one more unread». The server number (the fetch) and the SSE stream are two views of the same
 * messages: on the FIRST connect the server replays the person's still-pending events (`is_backfill: true`, events.py `_BACKFILL_INITIAL_EVENTS`) —
 * messages that arrived while nobody was connected, which the fetch already counts. `prev + 1` for each of them showed 4 unread on a server that had 2
 * (measured on dev, both phones: fetch `count:2` and two replayed `conversation.message_created` landed in the same tick). The same double count
 * happens when a live event arrives while the first fetch is out (its answer may or may not include it), and an event before any server number
 * is known would count from 0. In those cases the event only means «the number changed» — ask the server again (one shared recount for every badge
 * on the screen, sent once the events go quiet) instead of adding 1. A live event with a server number in hand keeps the instant +1. A request that fails
 * leaves no number we can trust, so the next event asks again instead of adding to a stale one.
 * story 4881 — the number belongs to ONE organization. Switching organization (the switcher's `switchOrg` / `switchOrgAndProject` → `router.refresh()`, or the shell's automatic
 * switch) keeps this hook mounted, and nothing in it noticed: the badge kept the old organization's number (dev, measured: B 4 → switch to A → badge 4, server 2; a new message
 * 5 vs 3), because a stream that reconnects for the new organization replays only events the page has not seen — events it already saw are dropped by the per-hook dedup, so no
 * replay came to ask the server again. Now the hook is keyed on the organization the shell puts on requests (`getEffectiveOrgId`): when it changes, the old number is dropped
 * at once (never show one organization's number under another's name), answers of requests the old organization sent are ignored, and the server is asked for the new
 * organization's number. A frame that carries the stream's organization (`stream_org_id`) and names another organization than the current one is from the stream the page just
 * left — it is ignored, never counted. Not covered: a stream whose frames carry no `stream_org_id` (older server) — those frames are counted as before.
 */
const RECOUNT_QUIET_MS = 250;
const RECOUNT_MAX_WAIT_MS = 1500; // a steady stream of events still gets a recount within this long of the burst's first event
const RECOUNT_MIN_GAP_MS = 1500; // …but two recounts are never closer than this: whatever the event spacing, at most ~0.67 requests a second
const refetchers = new Set<() => void>();
let recountTimer: ReturnType<typeof setTimeout> | null = null;
let recountFirstAt = 0;
let lastRecountAt = Number.NEGATIVE_INFINITY;
// The gaps are measured on the monotonic clock: the wall clock (`Date.now()`) can be set back by hand or jump when a sleeping machine wakes, and then «now − last recount»
// would be hugely negative and the next recount would never go out.
function scheduleServerRecount(): void {
  const now = performance.now();
  if (recountTimer) {
    clearTimeout(recountTimer); // trailing edge: the burst is not over yet
  } else {
    recountFirstAt = now;
  }
  // wait for quiet, but never past the ceiling counted from the first event of this burst…
  const quiet = Math.min(RECOUNT_QUIET_MS, Math.max(0, recountFirstAt + RECOUNT_MAX_WAIT_MS - now));
  // …and never sooner than the minimum gap after the last recount (events spaced just over the quiet wait would otherwise recount for each one)
  // (the gap term is also capped at the gap itself: a clock that misbehaves can postpone a recount by at most one gap, never for good)
  const wait = Math.max(quiet, Math.min(RECOUNT_MIN_GAP_MS, lastRecountAt + RECOUNT_MIN_GAP_MS - now));
  recountTimer = setTimeout(() => {
    recountTimer = null;
    lastRecountAt = performance.now();
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
  // story 4881 — the organization this number is for (what the shell puts on requests). The state remembers which organization its number was counted for, so after a switch the
  // render itself returns 0 for the new organization until the new number arrives — no effect has to reset it, and an answer for the old organization can never be shown.
  const orgKey = getEffectiveOrgId() ?? '';
  const [counted, setCounted] = useState<{ org: string; n: number }>({ org: orgKey, n: 0 });
  const fetchTotalRef = useRef<(() => void) | null>(null);
  // story 4876 — do we hold a server number yet, and is a request for it out right now
  const haveServerCountRef = useRef(false);
  const requestsOutRef = useRef(0);
  const mux = useSseMultiplexerContext();
  const muxRef = useRef(mux);
  useEffect(() => { muxRef.current = mux; }, [mux]);

  useEffect(() => {
    let cancelled = false;
    // story 4881 — a new organization starts with no number and no request out (the old effect's requests are cancelled above)
    haveServerCountRef.current = false;
    requestsOutRef.current = 0;
    async function fetchTotal(fresh = false) {
      // story #4263 AC1 — 공용 요청(진행 중이면 합류): 이 훅이 한 화면에 여럿 마운트돼도 같은 순간 1번(fetchWithAuth · 401 처리는 그 안).
      // ① 이벤트가 부른 재조회(fresh)는 이벤트 전에 뜬 요청에 합류하지 않는다.
      requestsOutRef.current += 1;
      const count = await fetchChatUnreadTotal({ fresh });
      if (cancelled) return; // story 4881 — a request this effect (this organization) sent: its answer never counts, and it no longer owns the request counter (the next effect reset it)
      requestsOutRef.current -= 1;
      if (count !== null) { haveServerCountRef.current = true; setCounted({ org: orgKey, n: count }); }
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
  }, [orgKey]);

  useChatSse({
    // story #4440 — my own message (now echoed to my other tabs) is never unread
    onConversationMessage: (payload) => {
      if (isOwnMessage(payload, currentTeamMemberId)) return;
      // story 4881 — a frame from the stream the page just left (it names another organization than the current one): not this organization's message
      const streamOrg = payload.stream_org_id;
      const nowOrg = getEffectiveOrgId();
      if (typeof streamOrg === 'string' && nowOrg && streamOrg.toLowerCase() !== nowOrg.toLowerCase()) return;
      // story 4876 — a replayed event (is_backfill), an event with no server number yet, or one that lands while a request is out only says
      // «the number changed»: take the server's number, never prev + 1 (the fetch may already count it)
      if (payload.is_backfill === true || !haveServerCountRef.current || requestsOutRef.current > 0) { scheduleServerRecount(); return; }
      setCounted((prev) => ({ org: prev.org, n: prev.n + 1 })); // (a +1 on a number of another organization is never shown: the render returns 0 for it and the new organization's recount replaces it)
    },
    onConversationRead: () => fetchTotalRef.current?.(),
    // story #1978(트랙C) — SSE 드롭 중 놓친 conversation.message_created는 낙관 +1이 못 따라오니
    // 재연결 시 서버 truth로 스냅해 drift를 없앤다. visibility/focus(위)는 이미 있었지만 그건
    // "탭이 백그라운드였다 포그라운드로" 축이고, 이건 "SSE 커넥션 자체가 끊겼다 재연결됐다"
    // 축이라 서로 다른 트리거다(탭은 계속 보이는데 네트워크만 끊겼다 복구된 경우 visibility는
    // 안 fire하지만 onReconnect는 fire한다).
    onReconnect: () => fetchTotalRef.current?.(),
  });

  return counted.org === orgKey ? counted.n : 0;
}
