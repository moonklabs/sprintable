'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSseMultiplexerContext, useSseConnectedContext } from '@/components/realtime-provider';
import { shouldSuppressDuplicateSseEvent, createSeenIdTracker } from '@/lib/realtime/sse-event-dedup';
import { createReconnectBackoffState, type ReconnectBackoffState } from '@/lib/realtime/sse-reconnect-backoff';
import { isSessionAlive } from '@/lib/realtime/sse-session-guard';
import { isCursorEligibleEventName } from '@/lib/realtime/sse-cursor-eligibility';
import { createVisibilityReconnectState } from '@/lib/realtime/sse-visibility-reconnect';

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
  // story #2901 — backend: sender.avatar_url. TeamMember/Member 소싱만 값이 있고
  // OrgMember 소싱(레거시 JWT-휴먼 일부 경로)은 컬럼 자체가 없어 항상 null.
  sender_avatar_url: string | null;
  content: string;
  /** story #2319 — set이면 tombstone됨(행은 남고 content는 서버가 이미 ""로 스크럽했다).
   * ChatBubble이 이 필드로 placeholder를 렌더한다(#2299 still_exists와 같은 축 — 「끊어짐」은
   * 사실 필드, 렌더는 FE 몫). */
  deleted_at?: string | null;
  review_type?: string;
  // asset_id — story #2803: BE가 전송 시 asset registry에 역기입하는 denorm 필드
  // (asset_registry.sync_attachment_assets). 구 메시지(registry 롤아웃 이전)엔 없을 수 있다.
  attachments: Array<{ url?: string; name?: string; content_type?: string; filename?: string; asset_id?: string }>;
  created_at: string;
  // CB-S9: thread fields
  parent_id?: string | null;    // null = top-level message; set = this is a thread reply
  reply_count?: number;
  last_reply_at?: string | null;
  /** story #2263 AC6 — 읽기 경로(list_messages/get_message/list_message_replies)만 싣는
   * stored 참조 사이드밴드(conversations.py fetch_stored_references). ⛔`undefined`(키
   * 자체가 없음 — SSE 디스패치·전송 직후 응답 등 이 필드를 안 주는 경로)와 `[]`(읽기 경로가
   * 실제로 0건을 확認)를 구분한다 — 전자는 "판단 재료 없음"이라 유령 판정을 보류(폴백,
   * 기존처럼 그대로 그린다)하고, 후자는 본문 토큰과 대조해 유령을 가른다. */
  /** story #2262 AC1(2026-08-08) — `form`·`referenced_at`는 `fetch_stored_references()`가
   * 이미 실어 오던 필드인데(mention_parser.py) 이 타입이 `target_type`·`target_id`만 받아
   * 그동안 버려지고 있었다. `form`: 'mention'|'embed'|'proof'(표면) · `referenced_at`:
   * ISO8601(이 참조가 «언제 생겼나» — 대상이 언제 만들어졌나가 아니다). */
  references?: Array<{ target_type: string; target_id: string; form?: string; referenced_at?: string }>;
  /** story #2349 — 「내가 이 메시지의 보낸이를 차단했는가」(주어=나). references와 같은 축:
   * 서버가 내려주되(tombstone처럼 안 내려주는 게 아니다) 가리는 건 클라 몫이다. `undefined`는
   * "판단 재료 없음"(이 필드를 안 주는 경로)이라 마스킹을 보류한다 — false로 기본값을 주면
   * "차단 여부 모름"이 "차단 안 함"으로 뭉개진다. */
  is_blocked_sender?: boolean;
  /** story #2604 P2 — BE(#3007)가 msg_metadata['approval_target']를 payload top-level에
   * additive로 노출(`_approval_payload`, `_activation_payload`와 동형). 있으면 결재 카드를
   * 렌더한다 — 없으면(구 메시지·approval_target 없는 일반 메시지) 항상 `null`(옛 서버는 키
   * 자체가 없을 수 있어 `?? null`로 통일, references류의 undefined/키부재 구분과 다른 축 —
   * 이 필드는 "카드냐 아니냐"라는 이분법이라 undefined와 null을 굳이 나눌 이유가 없다).
   * story #2624 — 결재 "결과" 회신 메시지(BE #3015)도 같은 필드를 싣되 actions 없이
   * decision/resolution_note를 대신 싣는다 — ApprovalRequestCard는 이 둘을 읽지 않고
   * gate_id로 fetchGate()한 실물(gate.status/resolution_note)만 신뢰하므로 타입만 넓힌다. */
  approval_target?: {
    work_item_type: string; work_item_id: string; gate_id: string;
    actions?: string[]; decision?: string; resolution_note?: string | null;
    /** story #2985 — 결재선 지정 시 이 카드의 수신자가 지정 결재자인지(true)/정보성으로
     * 강등된 나머지 owner·admin인지(false). 미지정 상신(designated_approver_id=None)이면
     * 전원 true(회귀 0) — approval_delivery.py::dispatch_approval_request_cards. */
    designated?: boolean;
    /** story #2985 — 지정 결재자 표시 이름(정보성 카드 안내문구용). 지정 없음/미확인이면
     * null. */
    designated_approver_name?: string | null;
  } | null;
  /** story #2637 AC0-a — BE(#3036)가 msg_metadata['event']를 payload top-level에 additive로
   * 노출(`_event_payload`, approval_target과 동형 패턴). 있으면 이 메시지는 이벤트 레지스트리
   * 발행분이다 — event_key로 event_definitions를 조회해 block_template이 있으면 그걸로,
   * 없으면 content(BE의 제네릭 폴백 텍스트, #2633 _render_event_message_content)를 그대로
   * 렌더한다(비회귀). 구서버/일반 메시지는 `?? null`로 통일(approval_target과 같은 이유). */
  event?: { event_key: string; payload: Record<string, unknown> } | null;
  /** story #2985 — 'request'(액션 카드)/'result'(회신 카드) 판별(BE msg_metadata.activation.kind
   * → _activation_payload가 top-level로 노출). story #3001부터 'request_info'는 BE가 더
   * 이상 발행하지 않는다(정보성 카드 폐기 — 카드 자체가 지정자에게만 간다). 구서버(undefined/
   * null)는 기존 렌더로 무회귀. */
  message_kind?: string | null;
}

// Normalize backend _to_chat_message format → ChatMessage
export function normalizeToMessage(raw: Record<string, unknown>): ChatMessage {
  const sender = raw.sender as { id?: string; name?: string; type?: string; avatar_url?: string | null } | undefined;
  return {
    id: (raw.id ?? '') as string,
    // conversation:message uses conversation_id; chat:message uses thread_id or memo_id
    memo_id: (raw.thread_id ?? raw.memo_id ?? raw.conversation_id ?? '') as string,
    created_by: (raw.created_by ?? sender?.id ?? '') as string,
    sender_name: (sender?.name ?? '') as string,
    sender_type: (sender?.type ?? 'human') as string,
    sender_avatar_url: (sender?.avatar_url ?? null) as string | null,
    content: (raw.content ?? '') as string,
    deleted_at: (raw.deleted_at ?? null) as string | null,
    attachments: (raw.attachments ?? []) as ChatMessage['attachments'],
    created_at: (raw.created_at ?? '') as string,
    // P1 RC: backend sends thread_id as parent pointer; raw.parent_id may be absent
    parent_id: (raw.parent_id ?? raw.thread_id ?? null) as string | null,
    reply_count: (raw.reply_count ?? 0) as number,
    last_reply_at: (raw.last_reply_at ?? null) as string | null,
    // story #2263 AC6 — key 부재(undefined)와 빈 배열([])을 그대로 통과시킨다. `raw.references
    // ?? []`처럼 기본값을 주면 "옛 서버라 필드가 없다"가 "참조 0건 확認됨"으로 뭉개져 유령
    // 판정이 항상 켜지는 회귀가 난다(오늘 아침 유령 칩 사고와 같은 모양).
    references: Array.isArray(raw.references) ? raw.references as ChatMessage['references'] : undefined,
    // story #2349 — references와 동일 규율: 키 부재(undefined)와 false를 구분한다.
    is_blocked_sender: typeof raw.is_blocked_sender === 'boolean' ? raw.is_blocked_sender : undefined,
    // story #2604 P2 — BE가 top-level에 항상 키를 싣진 않는 경로(구 메시지 등)도 있어 `?? null`.
    approval_target: (raw.approval_target ?? null) as ChatMessage['approval_target'],
    // story #2637 AC0-a — approval_target과 동일 규율.
    event: (raw.event ?? null) as ChatMessage['event'],
    // story #2985 — _activation_payload가 top-level에 싣는 message_kind 그대로.
    message_kind: (raw.message_kind ?? null) as string | null,
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
  // story #2163 — 이 훅 인스턴스 전용 dedup tracker(모듈 전역 아님). 이 컴포넌트가 언마운트되면
  // 같이 사라진다 — 다른 useChatSse 인스턴스(예: GNB 뱃지의 useChatUnreadTotal)를 굶기지 않는다.
  const seenIdsRef = useRef(createSeenIdTracker());
  const lastEventIdRef = useRef<string | null>(null);
  const onConversationMessageRef = useRef(onConversationMessage);
  const onWorkingRef = useRef(onWorking);
  const onConversationReadRef = useRef(onConversationRead);
  const onReconnectRef = useRef(onReconnect);
  const memberIdRef = useRef(currentTeamMemberId);
  // story #2964(#2940과 동일 클래스, 폴백 경로 전용) — memberId가 진짜로 바뀐 재실행(마운트·
  // mux 단독 토글이 아니라)인지 판별용.
  const prevMemberIdForResetRef = useRef(currentTeamMemberId);

  // useLayoutEffect: DOM commit 후 동기 실행 — useEffect(비동기)보다 먼저 실행되어
  // SSE 이벤트 도달 전에 ref가 항상 최신 콜백을 가리킴 (stale closure 방지)
  useLayoutEffect(() => { onConversationMessageRef.current = onConversationMessage; }, [onConversationMessage]);
  useLayoutEffect(() => { onWorkingRef.current = onWorking; }, [onWorking]);
  useLayoutEffect(() => { onConversationReadRef.current = onConversationRead; }, [onConversationRead]);
  useLayoutEffect(() => { onReconnectRef.current = onReconnect; }, [onReconnect]);
  useLayoutEffect(() => { memberIdRef.current = currentTeamMemberId; }, [currentTeamMemberId]);

  const handleConversationMessage = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
    try {
      onConversationMessageRef.current?.(JSON.parse(raw) as Record<string, unknown>);
    } catch { /* ignore parse errors */ }
  };
  const handleWorking = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
    try {
      const payload = JSON.parse(raw) as SseWorkingPayload;
      if (payload.conversation_id) onWorkingRef.current?.(payload);
    } catch { /* ignore parse errors */ }
  };
  const handleConversationRead = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
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
  // story 6ddaa086(critical, 선생님 실사고) — mux.connected(getter)는 mux 핸들 자체가
  // 참조안정적(realtime-provider.tsx 주석 참고)이라 값이 바뀌어도 리렌더를 못 유발했다
  // ("연결 끊겼어요" 배너가 정상 재연결 후에도 안 풀리는 근본원인). 반응형 전용 컨텍스트로
  // 교체.
  const muxConnected = useSseConnectedContext();

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

    // story #2964(sse-multiplexer.ts #2940과 동일 클래스) — org 전환으로 currentTeamMemberId가
    // 바뀌어도 이 effect가 재실행되지 않으면(구 deps=[mux, backoff]) 커넥션이 옛 member_id로
    // 남는다. memberIdRef 쓰기는 effect를 재트리거하지 못한다 — currentTeamMemberId를 deps에
    // 편입해 값이 실제로 바뀔 때만(문자열 값 비교) 재구독을 강제한다. 동시에 memberId가 진짜
    // 바뀐 경우에만 옛 org의 lastEventIdRef를 버린다(#3388 카디르 QA와 동일 근거 — 새 org
    // 커넥션에 옛 org의 last_event_id가 실리면 BE가 org 스코프 없이 그 id의 생성시각만으로
    // 백필기준을 잡아 조용히 누락된다). mux 단독 토글이나 최초 마운트에선 리셋하지 않는다.
    if (prevMemberIdForResetRef.current !== currentTeamMemberId) lastEventIdRef.current = null;
    prevMemberIdForResetRef.current = currentTeamMemberId;

    // story #2987 — sse-multiplexer.ts와 동일 처방(그쪽 주석 참고). 가시성 복귀 강제 재연결은
    // backoff.isReconnect()를 안 거치므로(onError 미경유) 이 플래그로 onReconnect(=backfill)를
    // 확실히 태운다.
    let pendingForcedReconnect = false;

    function connect() {
      sourceRef.current?.close();
      sourceRef.current = null;

      const url = new URL('/api/event-stream', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);
      if (lastEventIdRef.current) url.searchParams.set('last_event_id', lastEventIdRef.current);

      const source = new EventSource(url.toString());
      sourceRef.current = source;

      source.onopen = () => {
        const isReconnect = backoff.isReconnect() || pendingForcedReconnect;
        pendingForcedReconnect = false;
        setConnected(true);
        backoff.onOpen();
        // AC4: 재연결 시 backfill 트리거
        if (isReconnect) onReconnectRef.current?.();
      };

      source.onerror = () => {
        setConnected(false);
        // story #2160 — CLOSED는 브라우저가 이미 "복구 불가"로 판정한 것(자동재연결 없음).
        const wasFatal = source.readyState === EventSource.CLOSED;
        source.close();
        sourceRef.current = null;
        const scheduleRetry = () => {
          if (reconnectTimerRef.current) return;
          const delay = backoff.onError();
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, delay);
        };
        if (wasFatal) {
          void isSessionAlive().then((alive) => { if (alive) scheduleRetry(); });
          return;
        }
        scheduleRetry();
      };

      // conversation.message_created — realtime update for conversation list
      // S-COMM-12: canonical 이름만 리슨. server가 legacy(conversation:message)도 병행 emit하므로
      // 외부 consumer 하위호환은 server 레벨에서 처리됨 — 프론트가 둘 다 받으면 2회 발화됨.
      source.addEventListener('conversation.message_created', (e: MessageEvent) => {
        // story #2162 — B계열(presence·conversation.working)만 커서 승격 금지, 이 이벤트는 대상 아님.
        if (e.lastEventId && isCursorEligibleEventName('conversation.message_created')) lastEventIdRef.current = e.lastEventId;
        handleConversationMessage(e.data as string);
      });

      // R2(da9d1781): conversation.working — typing 인디케이터 1.5s 폴(/conversations/{id}/working) 대체.
      // payload 가 working 목록을 실어 보내므로 refetch 없이 직접 갱신.
      source.addEventListener('conversation.working', (e: MessageEvent) => {
        // story #2162 — DB Event 행이 없는 B계열이라 재개 커서로 승격하지 않는다(근본 원인 자리).
        if (e.lastEventId && isCursorEligibleEventName('conversation.working')) lastEventIdRef.current = e.lastEventId;
        handleWorking(e.data as string);
      });

      // story #1977: conversation.read — #1976이 본인 타 커넥션에만 전파(read-receipt 아님).
      // 다른 탭/기기에서 mark-read 하면 이 탭의 리스트 배지·GNB 총합을 서버 truth로 자가정정.
      source.addEventListener('conversation.read', (e: MessageEvent) => {
        // story #2162 — B계열만 커서 승격 금지, 이 이벤트는 대상 아님.
        if (e.lastEventId && isCursorEligibleEventName('conversation.read')) lastEventIdRef.current = e.lastEventId;
        handleConversationRead(e.data as string);
      });
    }

    connect();

    // story #2987 — sse-multiplexer.ts와 동일 처방(그쪽 주석 참고, sse-visibility-reconnect.ts
    // 공용 모듈). readyState는 좀비 커넥션을 못 잡으므로 가시성 복귀 시 무조건 강제 재연결한다.
    const visibilityState = createVisibilityReconnectState();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        visibilityState.onHidden();
        return;
      }
      if (visibilityState.onVisible()) {
        pendingForcedReconnect = true;
        connect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // #3388 카디르 QA MEDIUM과 동일 근거 — clearTimeout만으론 stale ref가 남아, 재마운트
      // (memberId 전환) 직후 대기 中이던 백오프 재시도가 stale ref에 걸려 건너뛸 수 있었다.
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [mux, backoff, currentTeamMemberId]);

  // story 6ddaa086 — 이전 주석은 "mux.connected가 이미 반응형"이라 적었으나 틀렸다: mux
  // 핸들 자체는 참조안정적이라(realtime-provider.tsx) getter 뒤 값이 바뀌어도 이 컴포넌트가
  // 리렌더되지 않았다. muxConnected(위, 전용 컨텍스트)만 실제로 반응형이다.
  return { connected: mux ? muxConnected : connected };
}
