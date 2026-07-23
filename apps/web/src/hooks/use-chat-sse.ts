'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { shouldSuppressDuplicateSseEvent } from '@/lib/realtime/sse-event-dedup';
import { createReconnectBackoffState, type ReconnectBackoffState } from '@/lib/realtime/sse-reconnect-backoff';

// chat-attach: 메시지 전송 시 첨부 메타 (BE MessageAttachment 계약과 동일).
export interface SendAttachment {
  url: string;
  name: string;
  content_type: string;
  size: number;
}

// Mirrors backend _to_chat_message: { id, thread_id, sender: { id, name, type }, ... }
export interface ChatMessage {
  id: string;
  memo_id: string;        // backend: thread_id (conversation_id for group chats)
  created_by: string;     // backend: sender.id
  sender_name: string;    // backend: sender.name
  sender_type: string;    // backend: sender.type ('human' | 'agent')
  content: string;
  review_type?: string;
  attachments: Array<{ url?: string; name?: string; content_type?: string; filename?: string }>;
  created_at: string;
  // CB-S9: thread fields
  parent_id?: string | null;    // null = top-level message; set = this is a thread reply
  reply_count?: number;
  last_reply_at?: string | null;
}

// Normalize backend _to_chat_message format → ChatMessage
export function normalizeToMessage(raw: Record<string, unknown>): ChatMessage {
  const sender = raw.sender as { id?: string; name?: string; type?: string } | undefined;
  return {
    id: (raw.id ?? '') as string,
    // conversation:message uses conversation_id; chat:message uses thread_id or memo_id
    memo_id: (raw.thread_id ?? raw.memo_id ?? raw.conversation_id ?? '') as string,
    created_by: (raw.created_by ?? sender?.id ?? '') as string,
    sender_name: (sender?.name ?? '') as string,
    sender_type: (sender?.type ?? 'human') as string,
    content: (raw.content ?? '') as string,
    attachments: (raw.attachments ?? []) as ChatMessage['attachments'],
    created_at: (raw.created_at ?? '') as string,
    // P1 RC: backend sends thread_id as parent pointer; raw.parent_id may be absent
    parent_id: (raw.parent_id ?? raw.thread_id ?? null) as string | null,
    reply_count: (raw.reply_count ?? 0) as number,
    last_reply_at: (raw.last_reply_at ?? null) as string | null,
  };
}

/** R2(da9d1781): conversation.working SSE payload — `chat_presence.list_working` 목록. */
export interface SseWorkingPayload {
  conversation_id: string;
  working: Array<{ member_id: string; state?: string }>;
}

/** story #1977: conversation.read SSE payload — #1976 mark-read 응답과 동일 shape(본인 타 커넥션 전파). */
export interface SseConversationReadPayload {
  conversation_id: string;
  member_id: string;
  last_read_at: string;
  unread_count: number;
}

interface UseChatSseOptions {
  currentTeamMemberId?: string;
  onConversationMessage?: (payload: Record<string, unknown>) => void;
  // R2: 채팅 working/typing — 1.5s 폴(/conversations/{id}/working) 대체.
  onWorking?: (payload: SseWorkingPayload) => void;
  // story #1977: conversation.read — 다른 탭/기기에서 읽음 처리 시 이 탭의 unread 배지(리스트+GNB) 자가정정.
  onConversationRead?: (payload: SseConversationReadPayload) => void;
  onReconnect?: () => void;
}

// story #2095 — 재연결 backoff는 sse-reconnect-backoff.ts(공용, sse-multiplexer.ts와
// 동일 모듈 재사용)로 뽑았다.

export function useChatSse({ currentTeamMemberId, onConversationMessage, onWorking, onConversationRead, onReconnect }: UseChatSseOptions) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // react-hooks/refs: 렌더 중 ref.current 조건부 대입 금지라 지연초기화는 useState(초기화 함수)로.
  const [backoff] = useState<ReconnectBackoffState>(() => createReconnectBackoffState());
  const lastEventIdRef = useRef<string | null>(null);
  const onConversationMessageRef = useRef(onConversationMessage);
  const onWorkingRef = useRef(onWorking);
  const onConversationReadRef = useRef(onConversationRead);
  const onReconnectRef = useRef(onReconnect);
  const memberIdRef = useRef(currentTeamMemberId);

  // useLayoutEffect: DOM commit 후 동기 실행 — useEffect(비동기)보다 먼저 실행되어
  // SSE 이벤트 도달 전에 ref가 항상 최신 콜백을 가리킴 (stale closure 방지)
  useLayoutEffect(() => { onConversationMessageRef.current = onConversationMessage; }, [onConversationMessage]);
  useLayoutEffect(() => { onWorkingRef.current = onWorking; }, [onWorking]);
  useLayoutEffect(() => { onConversationReadRef.current = onConversationRead; }, [onConversationRead]);
  useLayoutEffect(() => { onReconnectRef.current = onReconnect; }, [onReconnect]);
  useLayoutEffect(() => { memberIdRef.current = currentTeamMemberId; }, [currentTeamMemberId]);

  const handleConversationMessage = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw)) return;
    try {
      onConversationMessageRef.current?.(JSON.parse(raw) as Record<string, unknown>);
    } catch { /* ignore parse errors */ }
  };
  const handleWorking = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw)) return;
    try {
      const payload = JSON.parse(raw) as SseWorkingPayload;
      if (payload.conversation_id) onWorkingRef.current?.(payload);
    } catch { /* ignore parse errors */ }
  };
  const handleConversationRead = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw)) return;
    try {
      const payload = JSON.parse(raw) as SseConversationReadPayload;
      if (payload.conversation_id) onConversationReadRef.current?.(payload);
    } catch { /* ignore parse errors */ }
  };

  // story #2078 — 멀티플렉서(플래그 ON)가 있으면 공유 커넥션에 이름별 구독만 얹는다.
  //
  // story #2136 — `chat:message`·`reply_created` 구독을 제거했다. 둘 다 BE emit 문자열과
  // 매치가 0(grep 확認, `reply_created`가 참조하던 `memos.py`는 backend에 아예 없음)이라
  // 실제로는 한 번도 fire된 적 없는 죽은 자리였고, 두 이벤트가 하려던 일(신규 메시지 반영)은
  // 이미 살아있는 canonical 경로 `conversation.message_created`(S-COMM-12, 아래
  // handleConversationMessage)가 전부 커버한다 — 별도 기능 손실 없이 제거.
  const mux = useSseMultiplexerContext();

  useEffect(() => {
    if (!mux) return;
    const unsubs = [
      mux.subscribe('conversation.message_created', handleConversationMessage),
      mux.subscribe('conversation.working', handleWorking),
      mux.subscribe('conversation.read', handleConversationRead),
      mux.subscribeReconnect(() => onReconnectRef.current?.()),
    ];
    return () => { for (const u of unsubs) u(); };
  }, [mux]);

  // 독립 연결 폴백(플래그 OFF 또는 Provider 밖) — story #2078 이전과 완전히 동일한 코드.
  useEffect(() => {
    if (mux || typeof EventSource === 'undefined') return;

    function connect() {
      sourceRef.current?.close();
      sourceRef.current = null;

      const url = new URL('/api/event-stream', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);
      if (lastEventIdRef.current) url.searchParams.set('last_event_id', lastEventIdRef.current);

      const source = new EventSource(url.toString());
      sourceRef.current = source;

      source.onopen = () => {
        const isReconnect = backoff.isReconnect();
        setConnected(true);
        backoff.onOpen();
        // AC4: 재연결 시 backfill 트리거
        if (isReconnect) onReconnectRef.current?.();
      };

      source.onerror = () => {
        setConnected(false);
        source.close();
        sourceRef.current = null;
        if (!reconnectTimerRef.current) {
          const delay = backoff.onError();
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, delay);
        }
      };

      // conversation.message_created — realtime update for conversation list
      // S-COMM-12: canonical 이름만 리슨. server가 legacy(conversation:message)도 병행 emit하므로
      // 외부 consumer 하위호환은 server 레벨에서 처리됨 — 프론트가 둘 다 받으면 2회 발화됨.
      source.addEventListener('conversation.message_created', (e: MessageEvent) => {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        handleConversationMessage(e.data as string);
      });

      // R2(da9d1781): conversation.working — typing 인디케이터 1.5s 폴(/conversations/{id}/working) 대체.
      // payload 가 working 목록을 실어 보내므로 refetch 없이 직접 갱신.
      source.addEventListener('conversation.working', (e: MessageEvent) => {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        handleWorking(e.data as string);
      });

      // story #1977: conversation.read — #1976이 본인 타 커넥션에만 전파(read-receipt 아님).
      // 다른 탭/기기에서 mark-read 하면 이 탭의 리스트 배지·GNB 총합을 서버 truth로 자가정정.
      source.addEventListener('conversation.read', (e: MessageEvent) => {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        handleConversationRead(e.data as string);
      });
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [mux, backoff]);

  // mux 경로에서는 로컬 connected state를 동기화하지 않고(setState-in-effect 회피) 멀티플렉서
  // 자신의 connected를 그대로 노출한다 — 이미 반응형(context 값 변경 시 이 훅도 리렌더).
  return { connected: mux ? mux.connected : connected };
}
