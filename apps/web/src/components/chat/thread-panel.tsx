'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { IconButton } from '@/components/ds/icon-button';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { newClientNonce, normalizeToMessage, sentMessageFromAnswer } from '@/hooks/use-chat-sse';
import { ChatBubble } from './chat-bubble';
import { ChatInput } from './chat-input';
import { SupportLauncherClearance } from '@/components/support-widget/support-launcher-clearance';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';
import { useEntityStatusBatchFetch } from '@/hooks/use-entity-status-batch';
import { useGateBatchFetch } from '@/hooks/use-gate-batch';
import type { CardState as GateCardState } from '@/components/chat/approval-request-card';
import type { EventDefinitionSummary } from '@/lib/block-template';

import { fetchWithAuth } from '@/lib/db/client';
import { useToast } from '@/components/ui/toast';
import { announceChatMessageDeleted } from '@/lib/chat-message-deleted';
import { actorRowLabels } from '@/lib/member-display';
import { LAYER } from '@/components/ds/layers';

// story #2262 PR② — 배치조회가 꺼진(구 호출부) 경우 훅에 넘길 안정적인 빈 배열 참조(매
// 렌더 새 배열을 만들면 useEntityStatusBatchFetch의 effect가 messages 변경으로 오인해
// 매번 재실행된다 — 어차피 빈 배열이라 fetch는 안 나가지만 불필요한 재실행 자체를 막는다).
const EMPTY_THREAD_MESSAGES: ChatMessage[] = [];

interface ThreadPanelProps {
  parentMessage: ChatMessage;
  conversationId: string;
  currentTeamMemberId: string;
  projectId?: string;
  onClose: () => void;
  // Injected by parent SSE to push new thread messages
  incomingMessage?: ChatMessage | null;
  // P2 RC: notify parent to increment reply_count when own reply sent
  onReplyAdded?: (parentId: string) => void;
  /** story #2262 AC2 PR② — ChatView가 만든 「대화 전체 1개」 캐시·요청장부를 그대로
   * 물려받는다(별도로 안 만든다) — 부모 메시지는 이미 채워진 캐시를 그리기만 하지만,
   * 스레드 답글 자신의 참조는 이 훅으로 직접 배치조회한다(같은 requestedKeysRef를
   * 공유해 중복 fetch 방지, PO 지적 2026-08-08 — 스레드 전용 참조가 예전엔 영원히
   * "아직 모름"에 고착됐었다). 둘 다 생략하면(undefined) 스레드 패널 배치조회 자체가
   * 꺼진다(기존 회귀 없음 — 옛 테스트 호출부 대비). */
  entityStatusByKey?: Record<string, EntityStatusFetchState>;
  requestedEntityStatusKeysRef?: RefObject<Set<string>>;
  setEntityStatusByKey?: (updater: (prev: Record<string, EntityStatusFetchState>) => Record<string, EntityStatusFetchState>) => void;
  /** story #2637 — chat-view.tsx의 event_definitions 카탈로그 캐시를 그대로 물려받는다
   * (entityStatusByKey와 동일 이유·별도로 안 만든다). */
  eventDefinitionsByKey?: Record<string, EventDefinitionSummary> | null;
  /** story #5ace2e84 — chat-view.tsx의 gate 배치조회 캐시·요청장부를 그대로 물려받는다
   * (entityStatusByKey와 동일 이유). 스레드 답글에 걸린 결재카드도 같은 장부를 공유해
   * 부모 메시지 카드와 중복 fetch가 안 난다. 둘 다 생략하면(undefined) 이 패널의 gate
   * 배치조회가 꺼지고 카드는 개별 fetchGate()로 자연 폴백(회귀 0). */
  gateByKey?: Record<string, GateCardState>;
  requestedGateIdsRef?: RefObject<Set<string>>;
  setGateByKey?: (updater: (prev: Record<string, GateCardState>) => Record<string, GateCardState>) => void;
  /** 답글 뱃지 안 꺼지는 버그 fix(2026-08-24, 선생님 리포트) — chat-view.tsx의 markRead(top-level
   * mark-read와 동일 엔드포인트·멱등 GREATEST 래칫)를 그대로 물려받는다. 이 패널은 열리면 항상
   * 최신 답글까지 자동 스크롤(위 shouldScrollToBottomRef)이라 "열람=끝까지 봄"이 성립 — 로드
   * 완료 시·신규 답글 수신 시 마크리드해야 conversation-level unread_count가 내려간다(스레드
   * 답글도 parent_id 구분 없이 unread_count를 올리는 chat-list-view.tsx#applyConversationMessageUpdate
   * 와 대칭). */
  /** deleting the ORIGINAL message (shown at the top of the thread) is the room's business — it lives in the room's list: the room hands its own delete handler */
  onDeleteParent?: (messageId: string) => void;
  onMarkRead?: (upToIso: string) => void;
}

export function ThreadPanel({
  parentMessage,
  conversationId,
  currentTeamMemberId,
  projectId,
  onClose,
  incomingMessage,
  onReplyAdded,
  entityStatusByKey,
  requestedEntityStatusKeysRef,
  setEntityStatusByKey,
  eventDefinitionsByKey,
  gateByKey,
  requestedGateIdsRef,
  setGateByKey,
  onMarkRead,
  onDeleteParent,
}: ThreadPanelProps) {
  // story #3783 — "불러오는 중…", common ns의 기존 loading 키 재사용.
  const tc = useTranslations('common');
  const t = useTranslations('chats');
  const { addToast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]); // the delete handler reads the replies as they are now
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  // AC6: CB-S8 패턴 — render 후 DOM 반영된 직후 스크롤 보장
  const shouldScrollToBottomRef = useRef(false);

  // story #2262 PR② — ChatView가 안 물려주면(구 호출부·테스트) 배치조회 기능 자체를 끈다
  // (fetch 자체가 안 나가게 messages를 빈 배열로 훅에 넘긴다 — hook 자체는 rules-of-hooks
  // 때문에 조건부 호출 불가라 항상 부르되 입력으로 무력화한다).
  const localRequestedKeysRef = useRef<Set<string>>(new Set());
  const noopSetEntityStatusByKey = useCallback(() => {}, []);
  useEntityStatusBatchFetch(
    setEntityStatusByKey ? messages : EMPTY_THREAD_MESSAGES,
    requestedEntityStatusKeysRef ?? localRequestedKeysRef,
    setEntityStatusByKey ?? noopSetEntityStatusByKey,
  );

  // story #5ace2e84 — 위 entityStatusByKey와 동일 정신(꺼짐 폴백 패턴 그대로).
  const localRequestedGateIdsRef = useRef<Set<string>>(new Set());
  const noopSetGateByKey = useCallback(() => {}, []);
  useGateBatchFetch(
    setGateByKey ? messages : EMPTY_THREAD_MESSAGES,
    requestedGateIdsRef ?? localRequestedGateIdsRef,
    setGateByKey ?? noopSetGateByKey,
  );

  const fetchThreadMessages = useCallback(async () => {
    try {
      const res = await fetchWithAuth(
        `/api/conversations/${conversationId}/messages?thread_id=${parentMessage.id}`,
      );
      if (!res.ok) return;
      const raw = await res.json() as Record<string, unknown>;
      const rawData = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Record<string, unknown>[];
      const data = rawData.map(normalizeToMessage);
      setMessages(data);
      // 패널이 열리면 항상 하단까지 스크롤(아래 effect)이라 "로드=최신까지 열람" — 답글이
      // 없으면 원 메시지까지만 본 것이므로 parentMessage.created_at으로 마크리드.
      const latest = data[data.length - 1];
      onMarkRead?.(latest ? latest.created_at : parentMessage.created_at);
    } finally {
      setLoading(false);
    }
  }, [conversationId, parentMessage.id, parentMessage.created_at, onMarkRead]);

  useEffect(() => {
    void fetchThreadMessages();
  }, [fetchThreadMessages]);

  // Scroll to bottom on load
  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [loading]);

  // AC4/AC6: SSE 주입 + CB-S8 패턴 스크롤 (setTimeout 제거)
  useEffect(() => {
    if (!incomingMessage) return;
    setMessages((prev) => {
      if (prev.some((m) => m.id === incomingMessage.id)) return prev;
      return [...prev, incomingMessage];
    });
    shouldScrollToBottomRef.current = true;
    // 패널이 열려있는 동안 도착한 답글도 자동 스크롤로 즉시 열람됨 — top-level chat-view.tsx의
    // addMessage(nearBottom일 때 markRead)와 동형.
    onMarkRead?.(incomingMessage.created_at);
  }, [incomingMessage, onMarkRead]);

  // AC6: 매 render 후 플래그 확인 → DOM 업데이트 직후 스크롤 (bare useEffect)
  useEffect(() => {
    if (shouldScrollToBottomRef.current) {
      shouldScrollToBottomRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  });

  const handleSend = useCallback(async (content: string, mentionedIds?: string[]) => {
    const body: Record<string, unknown> = { content, thread_id: parentMessage.id, client_nonce: newClientNonce() }; // story #4440
    if (mentionedIds && mentionedIds.length > 0) body.mentioned_ids = mentionedIds;
    const res = await fetchWithAuth(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to send thread reply');
    const raw = await res.json() as Record<string, unknown>;
    const msg = sentMessageFromAnswer(raw); // story #4430 — the send answer's `delivery` on the sender's own line
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    // P2 RC: SSE excludes own messages → manually bump parent reply_count
    onReplyAdded?.(parentMessage.id);
    // AC3/AC6: optimistic update 후 render 완료 시 스크롤
    shouldScrollToBottomRef.current = true;
  }, [conversationId, parentMessage.id, onReplyAdded]);

  // [SID:4311 PR 3] 원본 + 답글 한 목록 — 같은 이름 서로 다른 발신자 둘이면 «· ID 앞 8자»(발신자 id마다 한 번 · 내 메시지는 «나»라 셈에서 뺌).
  const senderLabels = actorRowLabels([parentMessage, ...messages].filter((m) => m.created_by !== currentTeamMemberId).map((m) => ({ id: m.created_by, label: m.sender_name || t('team') })));

  // what the thread is ABOUT, in one word (the head says «스레드 ··· {kind} · N개의 답글»): an approval request, an event card, a command's result or a plain message
  const parentKind = parentMessage.approval_target ? t('approvalRequestLabel')
    : parentMessage.event ? t('threadKindEvent')
    : parentMessage.server_command ? t('serverCommandBadge')
    : t('threadKindMessage');

  // story 4887 — the message menu inside a thread used to be a dead end («답글 달기» · «삭제» did nothing). A thread is flat: «reply» means «write in THIS thread» — the composer takes the focus.
  const focusReply = useCallback(() => {
    panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, []);

  // the same tombstone the room's list uses (the row stays as a placeholder; a failure is always shown — story #2319 AC②)
  const handleDeleteReply = useCallback(async (messageId: string) => {
    try {
      const res = await fetchWithAuth(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast({ type: 'error', title: t('deleteMessageErrorTitle'), body: t('deleteMessageErrorBody') });
        return;
      }
      const body = (await res.json()) as { deleted_at?: string | null };
      // the room LIST may hold this reply as the room's latest message (its one-line preview): tell it
      const gone = messagesRef.current.find((m) => m.id === messageId);
      if (gone) announceChatMessageDeleted({ conversationId, createdAt: gone.created_at });
      setMessages((prev) => prev.map((m) => (
        m.id === messageId ? { ...m, content: '', deleted_at: body.deleted_at ?? new Date().toISOString() } : m
      )));
    } catch {
      addToast({ type: 'error', title: t('deleteMessageErrorTitle'), body: t('deleteMessageErrorBody') });
    }
  }, [conversationId, addToast, t]);

  return (
    <div ref={panelRef} className={`flex h-full flex-col overflow-hidden border-l border-border ${LAYER.panel}`} data-testid="thread-panel">
      {/* Header — story #2911(S2e②③/R4) 「s2e-thread-depth-grammar」 확定: ReadingPanel과
          «같은 칩 브레드크럼» 문법(칩 버튼 + `›` text-border 구분자, 동일 토큰/스타일).
          「스레드」 평문 폐기. 스레드는 단일 레벨이라 세그먼트는 정확히 2개 — [대화](뒤로
          어포던스, 모바일 「← 대화」 텍스트 바를 이 칩이 대체) › [원 메시지 요약](스크롤로
          pin이 밀려도 헤더에 «어느 스레드인지» 상시 유지, 현 위치라 비클릭·ReadingPanel의
          최상단 세그먼트와 같은 문법). tint는 유나양 확定(2026-08-21) — chat_message는
          의도적 무색(§2263 C-7)이고 메시지는 5계열 어느 의미도 아니라 둘 다 중립 muted bg
          하나로 통일, 구분은 색이 아니라 아이콘+텍스트 weight로만(아래). */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-ds-line px-4 py-2" data-testid="thread-head">
        {/* the phone's way back to the room: a thread is a full screen there */}
        <IconButton icon="arrow_back" label={t('title')} onClick={onClose} className="-ml-1 lg:hidden" data-testid="thread-back" />
        <h2 className="m-0 text-ds-body font-semibold text-ds-ink">{t('threadLabel')}</h2>
        <p className="ml-auto min-w-0 truncate font-mono text-ds-mono-md text-ds-ink-3" data-testid="thread-meta">
          {parentKind} · {t('replyCount', { count: messages.length })}
        </p>
        <IconButton icon="close" label={t('closeThread')} onClick={onClose} />
      </div>

      {/* story 4887 (UI-4 screen PR · the approved thread) — the original message sits at the top as the thread's subject: no «원본 메시지» label, no rail — a card (approval · event) already draws itself as a card */}
      <div className="flex-shrink-0 border-b border-ds-line px-4 py-3" data-testid="thread-original">
        <ChatBubble
          message={parentMessage}
          isMine={parentMessage.created_by === currentTeamMemberId}
          plainRow
          isGrouped={false}
          onMenuReply={focusReply}
          onDelete={onDeleteParent}
          senderLabel={senderLabels.get(parentMessage.created_by)}
          projectId={projectId}
          entityStatusByKey={entityStatusByKey}
          eventDefinitionsByKey={eventDefinitionsByKey}
          gateByKey={gateByKey}
        />
      </div>

      {/* Thread messages — 유나양 design 반려 fix(2026-08-21, 로컬 렌더 실측): 이전
          `py-3`의 top 12px가 pin 블록 rail-bottom과 답글 rail-top 사이를 세로로 끊었다
          (「코드 연속≠픽셀 연속」). pt-0으로 상단 패딩 제거해 flush — border-b는 구분자로
          그대로 유지. */}
      <div className="flex-1 overflow-y-auto px-4 pb-3 pt-1" data-testid="thread-replies">
        {loading ? (
          <p className="text-center text-sm text-muted-foreground">{tc('loading')}</p>
        ) : messages.length === 0 ? (
          <p className="pt-3 text-center text-sm text-muted-foreground">{t('noRepliesYet')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((msg, idx) => {
              const prev = messages[idx - 1];
              const isGrouped = Boolean(prev && prev.created_by === msg.created_by);
              return (
                <ChatBubble
                  key={msg.id}
                  message={msg}
                  isMine={msg.created_by === currentTeamMemberId}
                  plainRow
                  isGrouped={isGrouped}
                  onMenuReply={focusReply}
                  onDelete={handleDeleteReply}
                  senderLabel={senderLabels.get(msg.created_by)}
                  projectId={projectId}
                  entityStatusByKey={entityStatusByKey}
                  eventDefinitionsByKey={eventDefinitionsByKey}
                  gateByKey={gateByKey}
                />
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input — story 4906: while the round support button is drawn the thread composer keeps its right 64px free, so [Send] is not under it */}
      <SupportLauncherClearance>
        <ChatInput
          // story #2032: 스레드 답글 초안은 부모 대화의 본문 초안과 같은 슬롯을 쓰면 서로
          // 덮어써 사고가 난다(AC3, "A 대화 초안이 B 대화에 나타나면 사고"와 같은 클래스) —
          // conversationId만이 아니라 parentMessage.id까지 합성해 스레드별로도 분리한다.
          threadId={`${conversationId}:thread:${parentMessage.id}`}
          onSend={handleSend}
          projectId={projectId}
          placeholder={t('threadReplyPlaceholder')}
          // story #2032 AC5류 우선순위 — 스레드 패널이 열린 상태에서 ESC는 대화 전체를 나가는
          // 것이 아니라 이 패널을 먼저 닫는다(중첩 오버레이는 안쪽부터 닫히는 것과 동형).
          onEscape={onClose}
        />
      </SupportLauncherClearance>
    </div>
  );
}
