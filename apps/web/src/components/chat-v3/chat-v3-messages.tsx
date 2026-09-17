'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmbedCard } from '@/components/chat/embed-card';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/db/client';
import { ChatV3EventCard } from './chat-v3-event-card';
import { normalizeToMessage, type ChatMessage } from '@/hooks/use-chat-sse';
import type { TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

// story #4008 CHANGES 2(PO 지적, 2026-09-17) — 이 컴포넌트가 chat-v3-screen.tsx와 각자
// useChatSse를 불러 탭당 SSE 연결이 prod 설정(SSE_MULTIPLEX_ENABLED=false, cloud-build.yml)
// 에서 2개로 늘었다(멀티플렉서 없으면 훅 호출마다 독립 EventSource — use-chat-sse.ts 폴백
// 경로). 구독은 chat-v3-screen.tsx 한 곳으로 올리고, 이 컴포넌트는 그 결과를 ref로
// 받기만 한다(상태를 부모로 끌어올리는 대신 최소 변경 — messages 배열 자체는 여기 소유
// 유지, 부모는 "새 메시지 왔다"만 알려준다).
export interface ChatV3MessagesHandle {
  receiveMessage: (payload: Record<string, unknown>) => void;
  reload: () => void;
}

/**
 * story #3972 AC1④ — 「대화 열」은 `ChatView`(옛 `/chats` 전용, 인라인 승인 등 이
 * 시안 밖 기능이 많이 딸려 있음)를 통째로 쓰지 않고, 조각(메시지 프록시·임베드 칩
 * 컴포넌트·전송 POST)만 재사용해 얇게 새로 짠다 — «열린 산출물»(맥락 패널)을
 * 이 메시지 배열에서 같이 파생해야 해서(references[] 최근 artifact), ChatView가
 * 그 상태를 밖으로 안 내놓는 이상 블랙박스로 못 쓴다(콜 중복 방지 — 최소 3콜 예산).
 */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function formatDayLabel(key: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${key}T00:00:00`));
}

export interface ChatV3MessagesProps {
  threadId: string;
  meId: string;
  agentName: string;
  locale: string;
  needsMe: TodayNeedsMeItem[];
  // story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — 이벤트 카드 서명
  // 버튼도 같은 게이트(TODAY_V3_ENABLED OFF면 /today가 404).
  todayV3Enabled: boolean;
  onOpenArtifactChange: (artifactId: string | null) => void;
  // story #3990 — 「근거」·「이력」 절이 스코프할 일(work item). 열린 산출물과 같은
  // 파생 규칙(최근 메시지부터 훑어 첫 story/task 참조)이라 같은 루프에서 같이 뽑는다
  // (메시지 배열 재순회 0).
  onWorkItemRefChange: (ref: { type: 'story' | 'task'; id: string } | null) => void;
}

export const ChatV3Messages = forwardRef<ChatV3MessagesHandle, ChatV3MessagesProps>(function ChatV3Messages({
  threadId, meId, agentName, locale, needsMe, todayV3Enabled, onOpenArtifactChange, onWorkItemRefChange,
}, ref) {
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // story #4008 CHANGES(유나 design·PO 지적, 2026-09-17) — 재연결·탭 복귀마다 이 화면이
  // 스켈레톤으로 순간 비워졌다: reload()가 이 함수를 그대로 불러 매번 setMessages(null)부터
  // 했기 때문(레일 쪽 handleThreadMessage는 성공 때만 교체해 안 비워지는 것과 대조).
  // `silent`(reload 전용)이면 기존 messages를 유지한 채 뒤에서 받아 교체하고, 실패해도
  // 기존 화면을 그대로 둔다(에러 상태로 안 바꿈) — 스켈레톤은 첫 로드·대화 전환(threadId
  // 변경으로 이 콜백 자체가 재생성될 때)에만 뜬다.
  const loadMessages = useCallback((options?: { silent?: boolean }) => {
    let cancelled = false;
    if (!options?.silent) {
      setMessages(null);
      setLoadError(false);
    }
    fetchWithAuth(`/api/conversations/${threadId}/messages`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: ChatMessage[] }) => {
        if (cancelled) return;
        const list = json.data ?? [];
        setMessages(list);
        // story #3972 — 최근 것부터 훑어 첫 artifact 참조를 「열린 산출물」로(맥락 패널).
        // story #3990 — 같은 한 번의 역순회에서 첫 story/task 참조도 같이 뽑는다(「근거」·
        // 「이력」 스코프, #3972와 동일 "가장 최근 참조 1개" 규칙 — 재순회 0).
        let latestArtifactId: string | null = null;
        let latestWorkItemRef: { type: 'story' | 'task'; id: string } | null = null;
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const refs = list[i]?.references ?? [];
          if (latestArtifactId === null) {
            const found = refs.find((r) => r.target_type === 'artifact');
            if (found) latestArtifactId = found.target_id;
          }
          if (latestWorkItemRef === null) {
            const found = refs.find((r) => r.target_type === 'story' || r.target_type === 'task');
            if (found) latestWorkItemRef = { type: found.target_type as 'story' | 'task', id: found.target_id };
          }
          if (latestArtifactId !== null && latestWorkItemRef !== null) break;
        }
        onOpenArtifactChange(latestArtifactId);
        onWorkItemRefChange(latestWorkItemRef);
      })
      .catch(() => {
        if (cancelled) return;
        // silent(reload) 실패는 기존 messages를 그대로 둔다(PO 처방 — "실패면 기존 유지").
        if (!options?.silent) setLoadError(true);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onOpenArtifactChange/onWorkItemRefChange는 부모가 매 렌더 새로 안 만든다는 계약(useCallback) 가정 밖·threadId 변경 시만 재조회.
  }, [threadId]);

  useEffect(() => loadMessages(), [loadMessages]);

  useEffect(() => {
    // jsdom(테스트 환경)엔 scrollIntoView가 없다 — 방어적 optional call(실 브라우저는 항상 있음).
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages]);

  // story #4008 AC2 — 내가 보낸 POST 응답과 SSE 에코가 같은 메시지를 두 번 넣지
  // 않게 id로 dedupe(chat-view.tsx addMessage와 동일 규율).
  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      if (!prev) return prev;
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  // story #4008 CHANGES 2 — SSE 구독 자체는 chat-v3-screen.tsx의 단일 useChatSse
  // 인스턴스가 갖고 있다(탭당 연결 1개 유지, 위 import 주석 참고). 이 화면(선택된
  // 스레드)에 온 새 메시지만 반영하는 threadId 필터는 부모가 이미 selectedId로
  // 걸러서 넘겨주므로(receiveMessage는 매칭된 것만 호출됨) 여기선 정규화+dedupe만.
  useImperativeHandle(ref, () => ({
    receiveMessage: (payload: Record<string, unknown>) => { addMessage(normalizeToMessage(payload)); },
    // story #4008 AC4 — 재연결(탭 복귀 포함) 시 놓친 메시지를 1회 재조회로 따라잡는다
    // (chat-view.tsx handleReconnect와 동형 — v3는 백그라운드 backfill-merge 없이
    // 단순 재조회로 충분한 규모). silent — 위 CHANGES 주석 참고(스켈레톤으로 안 비움).
    reload: () => { loadMessages({ silent: true }); },
  }), [addMessage, loadMessages]);

  const handleSend = async () => {
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    const res = await fetchWithAuth(`/api/conversations/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setSending(false);
    if (res.ok) {
      setDraft('');
      const json = (await res.json().catch(() => null)) as { data?: ChatMessage } | null;
      if (json?.data) addMessage(json.data);
    }
  };

  let lastDay: string | null = null;

  return (
    <section className="flex min-w-0 flex-1 flex-col border-r border-border bg-background" data-testid="chat-v3-messages-column">
      {loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
          <Button size="sm" variant="outline" onClick={() => loadMessages()} data-testid="chat-v3-messages-retry">{tc('retry')}</Button>
        </div>
      ) : !messages ? (
        <div className="flex flex-1 flex-col gap-3 p-5" data-testid="chat-v3-messages-loading" aria-hidden="true">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="ml-auto h-10 w-2/3" />
          <Skeleton className="h-10 w-1/2" />
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-auto p-5">
          {messages.map((m) => {
            const isMine = m.created_by === meId;
            const key = dayKey(m.created_at);
            const showDay = key !== lastDay;
            lastDay = key;
            return (
              <div key={m.id}>
                {showDay ? (
                  <p className="mb-3 text-center text-xs text-muted-foreground">{formatDayLabel(key, locale)}</p>
                ) : null}
                <div className={isMine ? 'ml-auto max-w-[78%] text-right' : 'max-w-[78%]'}>
                  <p className="mb-1 text-xs text-muted-foreground">{isMine ? t('meLabel') : m.sender_name}</p>
                  <Card
                    radius="compact"
                    className={cn(
                      'inline-block px-3.5 py-2.5 text-sm',
                      isMine ? 'rounded-tr-sm bg-primary/10 text-left' : 'rounded-tl-sm',
                    )}
                  >
                    {m.content}
                  </Card>
                  {(m.references ?? []).map((ref) => (
                    <div key={`${ref.target_type}-${ref.target_id}`} className="mt-1.5">
                      <EmbedCard entity_type={ref.target_type} entity_id={ref.target_id} title={null} status={null} />
                    </div>
                  ))}
                  {m.approval_target ? (
                    <div className="mt-2">
                      <ChatV3EventCard
                        approvalTarget={m.approval_target}
                        content={m.content}
                        // 페드루 PO 지시(2026-09-17 00:08Z) — 서명 자리는 「오늘」 한
                        // 곳뿐(시안 SSOT) — 이 게이트가 보는 사람의 오늘 큐(needsMe)에
                        // 없으면 막다른 길이라 서명 버튼 자체를 숨긴다(자리 0).
                        isInTodayQueue={needsMe.some((item) => item.source === 'gate' && item.id === m.approval_target!.gate_id)}
                        todayV3Enabled={todayV3Enabled}
                        onDone={() => { /* story #3972 — 낙관 갱신 0, 다음 목록 재조회 때 반영(가짜 0) */ }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
          placeholder={t('instructionPlaceholder', { agent: agentName })}
          aria-label={t('instructionPlaceholder', { agent: agentName })}
          data-testid="chat-v3-compose-input"
        />
        <Button size="sm" disabled={!draft.trim() || sending} onClick={() => void handleSend()} data-testid="chat-v3-send-action">
          {t('sendAction')}
        </Button>
      </div>
    </section>
  );
});
