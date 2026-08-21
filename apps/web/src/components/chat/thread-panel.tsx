'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, MessageSquare, X } from 'lucide-react';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { normalizeToMessage } from '@/hooks/use-chat-sse';
import { ChatBubble } from './chat-bubble';
import { ChatInput } from './chat-input';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';
import { useEntityStatusBatchFetch } from '@/hooks/use-entity-status-batch';
import type { EventDefinitionSummary } from '@/lib/block-template';

import { fetchWithAuth } from '@/lib/db/client';

// story #2262 PR② — 배치조회가 꺼진(구 호출부) 경우 훅에 넘길 안정적인 빈 배열 참조(매
// 렌더 새 배열을 만들면 useEntityStatusBatchFetch의 effect가 messages 변경으로 오인해
// 매번 재실행된다 — 어차피 빈 배열이라 fetch는 안 나가지만 불필요한 재실행 자체를 막는다).
const EMPTY_THREAD_MESSAGES: ChatMessage[] = [];

// story #2911(S2e②③) — 헤더 칩의 "원 메시지 요약"은 순수 텍스트라야 한다(ChatBubble의 마크다운
// 렌더 전체를 여기 또 태우면 칩 안에 카드/칩이 중첩되는 사고). 마크다운 링크 `[라벨](...)`는
// 라벨만 남기고, 기본 강조 마커는 지운 뒤 공백을 접는다 — 시안이 요구하는 "≤15ch truncate"는
// CSS(max-w+truncate, ReadingPanel과 동일 패턴)가 처리하므로 여기선 자르지 않는다.
function plainPreview(content: string): string {
  return content
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
}: ThreadPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  const fetchThreadMessages = useCallback(async () => {
    try {
      const res = await fetchWithAuth(
        `/api/conversations/${conversationId}/messages?thread_id=${parentMessage.id}`,
      );
      if (!res.ok) return;
      const raw = await res.json() as Record<string, unknown>;
      const rawData = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Record<string, unknown>[];
      setMessages(rawData.map(normalizeToMessage));
    } finally {
      setLoading(false);
    }
  }, [conversationId, parentMessage.id]);

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
  }, [incomingMessage]);

  // AC6: 매 render 후 플래그 확인 → DOM 업데이트 직후 스크롤 (bare useEffect)
  useEffect(() => {
    if (shouldScrollToBottomRef.current) {
      shouldScrollToBottomRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  });

  const handleSend = useCallback(async (content: string, mentionedIds?: string[]) => {
    const body: Record<string, unknown> = { content, thread_id: parentMessage.id };
    if (mentionedIds && mentionedIds.length > 0) body.mentioned_ids = mentionedIds;
    const res = await fetchWithAuth(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to send thread reply');
    const raw = await res.json() as Record<string, unknown>;
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    const msg = normalizeToMessage(payload);
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    // P2 RC: SSE excludes own messages → manually bump parent reply_count
    onReplyAdded?.(parentMessage.id);
    // AC3/AC6: optimistic update 후 render 완료 시 스크롤
    shouldScrollToBottomRef.current = true;
  }, [conversationId, parentMessage.id, onReplyAdded]);

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border bg-background">
      {/* Header — story #2911(S2e②③/R4) 「s2e-thread-depth-grammar」 확定: ReadingPanel과
          «같은 칩 브레드크럼» 문법(칩 버튼 + `›` text-border 구분자, 동일 토큰/스타일).
          「스레드」 평문 폐기. 스레드는 단일 레벨이라 세그먼트는 정확히 2개 — [대화](뒤로
          어포던스, 모바일 「← 대화」 텍스트 바를 이 칩이 대체) › [원 메시지 요약](스크롤로
          pin이 밀려도 헤더에 «어느 스레드인지» 상시 유지, 현 위치라 비클릭·ReadingPanel의
          최상단 세그먼트와 같은 문법). tint는 유나양 확定(2026-08-21) — chat_message는
          의도적 무색(§2263 C-7)이고 메시지는 5계열 어느 의미도 아니라 둘 다 중립 muted bg
          하나로 통일, 구분은 색이 아니라 아이콘+텍스트 weight로만(아래). */}
      <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-border/80 px-2 py-1.5">
        {/* story #2911 — 유나양 확定(2026-08-21, C-7 논거: chat_message는 의도적 무색이고
            메시지는 5계열 어느 «의미」도 아니라 없는 뜻을 억지로 안 붙인다): 둘 다 muted bg
            하나로 통일, 구분은 색이 아니라 **아이콘+텍스트 weight**로만 — 「대화」=뒤로
            어포던스(ArrowLeft)+text-muted-foreground, 원 메시지=현재 위치(MessageSquare)+
            text-foreground font-medium. 신규 색 0. */}
        <button
          type="button"
          onClick={onClose}
          className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="size-3 shrink-0" />
          <span>대화</span>
        </button>
        <span className="text-xs text-border">›</span>
        <span
          title={plainPreview(parentMessage.content)}
          className="flex max-w-32 shrink items-center gap-1 rounded bg-muted px-1.5 py-1 text-xs font-medium text-foreground"
        >
          <MessageSquare className="size-3 shrink-0" />
          <span className="truncate">{plainPreview(parentMessage.content)}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="스레드 닫기"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* AC9: 원본 메시지. story #2911(S2e①/R4) — 좌측 rail(border-l-2)이 이 블록에서
          시작해 아래 답글 목록까지 같은 x-오프셋(pl-3)으로 끊김 없이 이어진다(스펙 §5 "원
          메시지 pin + 좌측 라인" — 답글이 원 메시지에서 뻗어나온 것처럼). 기존 border-border
          토큰 재사용(신규 색 0). */}
      <div className="flex-shrink-0 border-b border-l-2 border-border bg-muted/30 py-3 pl-3 pr-4">
        <p className="mb-1 text-[10px] font-medium text-muted-foreground">원본 메시지</p>
        <ChatBubble
          message={parentMessage}
          isMine={parentMessage.created_by === currentTeamMemberId}
          isGrouped={false}
          projectId={projectId}
          entityStatusByKey={entityStatusByKey}
          eventDefinitionsByKey={eventDefinitionsByKey}
        />
      </div>

      {/* Thread messages — 유나양 design 반려 fix(2026-08-21, 로컬 렌더 실측): 이전
          `py-3`의 top 12px가 pin 블록 rail-bottom과 답글 rail-top 사이를 세로로 끊었다
          (「코드 연속≠픽셀 연속」). pt-0으로 상단 패딩 제거해 flush — border-b는 구분자로
          그대로 유지. */}
      <div className="flex-1 overflow-y-auto pt-0 pb-3 pr-4">
        {loading ? (
          <p className="text-center text-sm text-muted-foreground">불러오는 중…</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">아직 답글이 없습니다.</p>
        ) : (
          // story #2911 — rail은 목록 전체를 감싸는 이 wrapper 하나(border-l-2, 원본 메시지
          // 블록과 동일 x-오프셋 — 둘 다 컨테이너 왼쪽 끝에서 시작)뿐이라 개별 ChatBubble
          // 그룹핑(isGrouped)과 무관하게 끊기지 않는다(AC3 — 한 줄로 쭉 이어지고, 그 안의
          // 버블 간격만 gap-2로 나뉜다).
          <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
            {messages.map((msg, idx) => {
              const prev = messages[idx - 1];
              const isGrouped = Boolean(prev && prev.created_by === msg.created_by);
              return (
                <ChatBubble
                  key={msg.id}
                  message={msg}
                  isMine={msg.created_by === currentTeamMemberId}
                  isGrouped={isGrouped}
                  projectId={projectId}
                  entityStatusByKey={entityStatusByKey}
                  eventDefinitionsByKey={eventDefinitionsByKey}
                />
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <ChatInput
        // story #2032: 스레드 답글 초안은 부모 대화의 본문 초안과 같은 슬롯을 쓰면 서로
        // 덮어써 사고가 난다(AC3, "A 대화 초안이 B 대화에 나타나면 사고"와 같은 클래스) —
        // conversationId만이 아니라 parentMessage.id까지 합성해 스레드별로도 분리한다.
        threadId={`${conversationId}:thread:${parentMessage.id}`}
        onSend={handleSend}
        projectId={projectId}
        placeholder="답글을 입력하세요… (Enter 전송 / Shift+Enter 줄바꿈)"
        // story #2032 AC5류 우선순위 — 스레드 패널이 열린 상태에서 ESC는 대화 전체를 나가는
        // 것이 아니라 이 패널을 먼저 닫는다(중첩 오버레이는 안쪽부터 닫히는 것과 동형).
        onEscape={onClose}
      />
    </div>
  );
}
