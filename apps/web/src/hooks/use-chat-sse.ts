'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSseMultiplexerContext, useSseConnectedContext } from '@/components/realtime-provider';
import { shouldSuppressDuplicateSseEvent, createSeenIdTracker } from '@/lib/realtime/sse-event-dedup';
import { createPollBackoffState, POLL_THRESHOLD_MS } from '@/lib/realtime/sse-polling-fallback';
import { parseAgentWake, type AgentWake } from '@/lib/chat/agent-wake';

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
  /** story #3106(#3092 후속) — backend: sender.runtime_type. agent만 값 있고 human은 항상
   * null(additive). Avatar의 runtimeType prop이 이 값으로 커넥터별 뱃지(CC·H 등)를 렌더 —
   * 없으면(구서버·human) 「Agent」 텍스트 폴백에 머문다. */
  sender_runtime_type: string | null;
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
  // story #4430 — participants a block kept this message from (a count, never who) · sent by the server to the sender only
  delivery_withheld?: DeliveryWithheld;
  // story #4761 (D3) — the agents this message reaches only when someone makes them look · in the send answer to the sender only
  agent_wake?: AgentWake;
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
  event?: {
    event_key: string;
    payload: Record<string, unknown>;
    /** story #3332 — 서버가 발행 시점에 계산한 참조 토큰(block_template의 {{ref.X}}용).
     * 구서버는 이 키 자체가 없다 — EventBlockCard가 undefined를 {}로 폴백한다(비회귀).
     * story #3884 — `work_item` 값이 dict로 넓어졌다(events.py `_render_event_
     * notification_work_item_ref`): 찾음(`{found:true, token}`)·리졸버는 있는데 못
     * 찾음(`{found:false, type}`)·리졸버 자체가 없음(키 자체 부재). 구계약(순 문자열)도
     * 방어적으로 허용(EventBlockCard가 둘 다 받는다).
     * story #3893 — `assignee`/`assigned_by` 값(events.py `_render_event_notification_
     * member_ref`): 찾음(`{found:true, name}`)·못 찾음(`{found:false}`) — member는 항상
     * 단일 리졸버라 "리졸버 자체가 없음" 갈래가 없다(work_item의 3모양 中 2모양만). */
    refs?: Record<string, string | null | { found: boolean; token?: string; type?: string; name?: string }>;
  } | null;
  /** story #2985 — 'request'(액션 카드)/'result'(회신 카드) 판별(BE msg_metadata.activation.kind
   * → _activation_payload가 top-level로 노출). story #3001부터 'request_info'는 BE가 더
   * 이상 발행하지 않는다(정보성 카드 폐기 — 카드 자체가 지정자에게만 간다). 구서버(undefined/
   * null)는 기존 렌더로 무회귀. */
  message_kind?: string | null;
  /** story #92f00dc4(Chat ②층 FE)/#9a5abc24(BE) — BE가 msg_metadata['server_command']를
   * payload top-level에 additive로 노출(approval_target/event와 동형 패턴). 있으면 이
   * 메시지는 서버가 결정적으로 집행한 커맨드(카탈로그: done/assign/priority)의 결과 카드다.
   * `candidates`는 outcome='ambiguous'일 때만 실리는 후보 이름 배열(페드루 판정, PR #3549
   * 리뷰 후속 — 문장 파싱 금지). 구서버(필드 부재)는 `?? null`로 통일 — FE는 candidates가
   * 없으면 후보 존 자체를 생략한다(파싱으로 지어내지 않는다).
   * `target_story_number`는 outcome='ambiguous'일 때만 실리는 원 스토리 번호(페드루 리뷰
   * PR #3552 후속, #9a5abc24 소델타 — 디디 몫). 후보 클릭 fill이 `/assign 채영1`처럼 스토리
   * 참조를 빠뜨리면 BE가 「채영1」을 스토리 ref로 오인해 invalid_args로 떨어진다 — 이 필드로
   * `/assign #<번호> <이름>`을 완전하게 채운다. 필드 부재(구서버·BE 델타 미착지)면 후보
   * 버튼을 비활성화한다(깨진 커맨드를 채우느니 기능 저하, PO 판정). */
  server_command?: {
    command: string;
    outcome: 'executed' | 'denied' | 'not_found' | 'ambiguous' | 'invalid_args';
    candidates?: string[];
    target_story_number?: number;
  } | null;
}

/**
 * story #4440 — the server now also sends a person's own new message to all their connections (their other tabs and devices
 * see it live). The tab that sent it already shows it (from the send answer), so it drops its own echo: by the nonce it made
 * before sending (PO 19:37Z — the echo can arrive before the send answer, when the tab does not know the id yet) or by the id
 * once the answer came. Per tab (module state); small and bounded.
 */
const SENT_HERE_MAX = 200;
// story #4442 — this tab's lists, told about each send made from this tab
const sentHereListeners = new Set<(payload: Record<string, unknown>) => void>();
const sentHereNonces: string[] = [];
const sentHereIds: string[] = [];

function remember(list: string[], value: string) {
  list.push(value);
  if (list.length > SENT_HERE_MAX) list.splice(0, list.length - SENT_HERE_MAX);
}

/** A nonce for one send from this tab (goes in the request as `client_nonce`); remembered here. */
export function newClientNonce(): string {
  const nonce = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  remember(sentHereNonces, nonce);
  return nonce;
}

/** The id of a message this tab sent (from the send answer). */
export function rememberSentHere(messageId: string | undefined | null) {
  if (messageId) remember(sentHereIds, messageId);
}

/** Is this payload this tab's own echo (sent from here)? */
export function isEchoOfSentHere(payload: Record<string, unknown>): boolean {
  const nonce = payload.client_nonce;
  if (typeof nonce === 'string' && sentHereNonces.includes(nonce)) return true;
  const id = payload.id;
  return typeof id === 'string' && sentHereIds.includes(id);
}

/** story #4440 — «my message»: its sender is me. One rule for every place that counts unread (a message of mine never is). */
export function isOwnMessage(payload: Record<string, unknown>, meId: string | undefined | null): boolean {
  if (!meId) return false;
  const sender = payload.sender as { id?: unknown } | undefined;
  return (typeof sender?.id === 'string' && sender.id === meId) || payload.created_by === meId;
}

/** story #4430 — how many participants a block kept a message from, and the room's kind (from who is in it). */
export interface DeliveryWithheld {
  withheld_count: number;
  conversation_type?: 'dm' | 'group';
}

/** A positive integer count or nothing — anything else from the wire is treated as «nothing withheld». */
export function parseDeliveryWithheld(v: unknown): DeliveryWithheld | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { withheld_count?: unknown; conversation_type?: unknown };
  const n = o.withheld_count;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return undefined;
  const kind = o.conversation_type === 'dm' || o.conversation_type === 'group' ? o.conversation_type : undefined;
  return kind ? { withheld_count: n, conversation_type: kind } : { withheld_count: n };
}

/**
 * story #4430 — the message from a send answer: `{data, delivery?}` (`delivery` is a sibling of `data`, like `command_gate`).
 * The sender's own line gets the same `delivery_withheld` a later read would give it — without this the mark would only
 * appear after a reload (a quiet success right when it matters).
 */
export function sentMessageFromAnswer(raw: Record<string, unknown>): ChatMessage {
  const payload = (raw.data ?? raw) as Record<string, unknown>;
  rememberSentHere(typeof payload.id === 'string' ? payload.id : null); // story #4440 — its echo is dropped here
  for (const listener of [...sentHereListeners]) listener(payload); // story #4442 — this tab's lists update their row
  const delivery = parseDeliveryWithheld(raw.delivery);
  const wake = parseAgentWake(raw.agent_wake); // story #4761 (D3) — a sibling of `data` too, like `delivery`
  const msg = normalizeToMessage(delivery ? { ...payload, delivery_withheld: delivery } : payload);
  return wake ? { ...msg, agent_wake: wake } : msg;
}

// Normalize backend _to_chat_message format → ChatMessage
export function normalizeToMessage(raw: Record<string, unknown>): ChatMessage {
  const sender = raw.sender as { id?: string; name?: string; type?: string; avatar_url?: string | null; runtime_type?: string | null } | undefined;
  return {
    id: (raw.id ?? '') as string,
    // conversation:message uses conversation_id; chat:message uses thread_id or memo_id
    memo_id: (raw.thread_id ?? raw.memo_id ?? raw.conversation_id ?? '') as string,
    created_by: (raw.created_by ?? sender?.id ?? '') as string,
    sender_name: (sender?.name ?? '') as string,
    sender_type: (sender?.type ?? 'human') as string,
    sender_avatar_url: (sender?.avatar_url ?? null) as string | null,
    sender_runtime_type: (sender?.runtime_type ?? null) as string | null,
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
    // story #4430 — kept, not dropped with the other unknown fields (a dropped field would be a quiet success again)
    delivery_withheld: parseDeliveryWithheld(raw.delivery_withheld),
    // story #2604 P2 — BE가 top-level에 항상 키를 싣진 않는 경로(구 메시지 등)도 있어 `?? null`.
    approval_target: (raw.approval_target ?? null) as ChatMessage['approval_target'],
    // story #2637 AC0-a — approval_target과 동일 규율.
    event: (raw.event ?? null) as ChatMessage['event'],
    // story #2985 — _activation_payload가 top-level에 싣는 message_kind 그대로.
    message_kind: (raw.message_kind ?? null) as string | null,
    // story #92f00dc4/#9a5abc24 — approval_target/event와 동일 규율(?? null 통일).
    server_command: (raw.server_command ?? null) as ChatMessage['server_command'],
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
  onConversationMessage?: (payload: Record<string, unknown>) => void;
  // R2: 채팅 working/typing — 1.5s 폴(/conversations/{id}/working) 대체.
  onWorking?: (payload: SseWorkingPayload) => void;
  // story #1977: conversation.read — 다른 탭/기기에서 읽음 처리 시 이 탭의 unread 배지(리스트+GNB) 자가정정.
  onConversationRead?: (payload: SseConversationReadPayload) => void;
  onReconnect?: () => void;
  /** story #3621 — `connected`가 threshold(기본 10s) 이상 false로 머물면 이 콜백을
   *  폴링 간격(기본 15s → 연속 실패 시 최대 30s)으로 반복 호출한다. Promise<boolean>|
   *  boolean 반환 — false/throw는 폴 실패로 간주해 다음 간격을 넓힌다(sse-polling-
   *  fallback.ts). 탭이 백그라운드면 폴링을 쉬고(방전 방지·기존 visibility 재조회
   *  규칙과 충돌 0), 재연결 성공(connected=true) 즉시 멈춘다 — 그 뒤는 기존
   *  onReconnect(backfill)가 이어받는다(중복 fetch 0). */
  onPoll?: () => Promise<boolean | undefined> | boolean | undefined;
  /**
   * story #4442 — a message this tab just sent (from its send answer). The tab drops its own echo (#4440), so the lists in
   * this tab (legacy list · v3 rail) take their row update from here instead. The chat view itself does not subscribe (it
   * already added the message).
   */
  onSentHere?: (payload: Record<string, unknown>) => void;
}

export function useChatSse({ onConversationMessage, onWorking, onConversationRead, onReconnect, onPoll, onSentHere }: UseChatSseOptions) {
  // story #2163 — 이 훅 인스턴스 전용 dedup tracker(모듈 전역 아님). 이 컴포넌트가 언마운트되면
  // 같이 사라진다 — 다른 useChatSse 인스턴스(예: GNB 뱃지의 useChatUnreadTotal)를 굶기지 않는다.
  const seenIdsRef = useRef(createSeenIdTracker());
  const onConversationMessageRef = useRef(onConversationMessage);
  const onWorkingRef = useRef(onWorking);
  const onConversationReadRef = useRef(onConversationRead);
  const onReconnectRef = useRef(onReconnect);
  const onPollRef = useRef(onPoll);

  // useLayoutEffect: DOM commit 후 동기 실행 — useEffect(비동기)보다 먼저 실행되어
  // SSE 이벤트 도달 전에 ref가 항상 최신 콜백을 가리킴 (stale closure 방지)
  useLayoutEffect(() => { onConversationMessageRef.current = onConversationMessage; }, [onConversationMessage]);
  // story #4442 — subscribe to this tab's own sends (only when asked: the lists)
  const onSentHereRef = useRef(onSentHere);
  useLayoutEffect(() => { onSentHereRef.current = onSentHere; }, [onSentHere]);
  const wantsSentHere = typeof onSentHere === 'function';
  useEffect(() => {
    if (!wantsSentHere) return;
    const listener = (p: Record<string, unknown>) => onSentHereRef.current?.(p);
    sentHereListeners.add(listener);
    return () => { sentHereListeners.delete(listener); };
  }, [wantsSentHere]);
  useLayoutEffect(() => { onWorkingRef.current = onWorking; }, [onWorking]);
  useLayoutEffect(() => { onConversationReadRef.current = onConversationRead; }, [onConversationRead]);
  useLayoutEffect(() => { onReconnectRef.current = onReconnect; }, [onReconnect]);
  useLayoutEffect(() => { onPollRef.current = onPoll; }, [onPoll]);

  const handleConversationMessage = (raw: string) => {
    if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      // story #4440 — this tab sent it and already shows it: its echo changes nothing here (no second reply count, no
      // second line). Other tabs and devices of the same person take it like any message.
      if (isEchoOfSentHere(payload)) return;
      onConversationMessageRef.current?.(payload);
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

  // story #2078 — 멀티플렉서의 공유 커넥션에 이름별 구독만 얹는다(story #4698 — 이 훅은 스트림을 열지 않는다).
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

  // story 6ddaa086 — 이전 주석은 "mux.connected가 이미 반응형"이라 적었으나 틀렸다: mux
  // 핸들 자체는 참조안정적이라(realtime-provider.tsx) getter 뒤 값이 바뀌어도 이 컴포넌트가
  // 리렌더되지 않았다. muxConnected(위, 전용 컨텍스트)만 실제로 반응형이다.
  // story #4698 — 독립 연결 폴백은 지웠다: Provider 밖(mux 없음)이면 스트림이 없으니 연결됨=false(아래 폴링 폴백이 이어받는다).
  const effectiveConnected = mux ? muxConnected : false;

  // story #3621 — connected가 threshold(기본 10s) 이상 false로 머물면 폴링 시작. mux
  // 경로·독립 연결 경로 둘 다 effectiveConnected 하나로 판정(경로 무관 동일 동작).
  // connected로 돌아오면(effect 재실행 → cleanup) 즉시 멈춘다 — onReconnect(backfill)가
  // 이어받으므로 폴링·backfill이 겹쳐 돌지 않는다(AC2). `polling`은 호출부가 배너 문구를
  // "끊김"에서 "폴링으로 갱신 중"으로 바꿔 다는 신호(AC3) — threshold 전엔 false.
  const [polling, setPolling] = useState(false);
  useEffect(() => {
    // polling은 초기값이 이미 false이고, 폴링이 실제로 돌던 상태에서 벗어날 때는 아래
    // cleanup이 false로 되돌린다 — 여기서 다시 동기 setState할 필요가 없다
    // (react-hooks/set-state-in-effect, 카스케이드 렌더 방지).
    if (!onPollRef.current || effectiveConnected) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pollBackoff = createPollBackoffState();

    const runPoll = () => {
      if (cancelled) return;
      setPolling(true);
      // story #1978/#3081과 동일 축 — 탭이 백그라운드면 폴링을 쉰다(방전 방지). 짧은
      // 간격(1s)으로 가시성 복귀를 감시해, 복귀 즉시 폴링을 재개한다.
      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (isHidden) {
        timer = setTimeout(runPoll, 1000);
        return;
      }
      void Promise.resolve()
        .then(() => onPollRef.current?.())
        .catch(() => false)
        .then((result) => {
          if (cancelled) return;
          pollBackoff.onPollResult(result !== false && result !== undefined);
          timer = setTimeout(runPoll, pollBackoff.currentIntervalMs());
        });
    };

    const thresholdTimer = setTimeout(runPoll, POLL_THRESHOLD_MS);

    return () => {
      cancelled = true;
      clearTimeout(thresholdTimer);
      if (timer) clearTimeout(timer);
      setPolling(false);
    };
  }, [effectiveConnected]);

  return { connected: effectiveConnected, polling };
}
