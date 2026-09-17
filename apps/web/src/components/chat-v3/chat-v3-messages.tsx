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
import { seedFromCompose } from './chat-v3-compose';
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
  // story #4028 — 주소 `?compose=`로 실려 온 첫 지시. 마운트 시 한 번만 입력창에 미리
  // 채운다(전송 0 — 사람이 직접 누른다). 부모(chat-v3-screen)가 주소에서 값을 캡처해
  // 넘겨주고 URL에선 compose를 지운다 — 여기선 그 값을 받기만 한다.
  initialCompose?: string | null;
}

export const ChatV3Messages = forwardRef<ChatV3MessagesHandle, ChatV3MessagesProps>(function ChatV3Messages({
  threadId, meId, agentName, locale, needsMe, todayV3Enabled, onOpenArtifactChange, onWorkItemRefChange, initialCompose,
}, ref) {
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // story #4028 — 주소의 첫 지시로 마운트 1회만 시드(상한 넘으면 안 싣고 안내). lazy
  // 초기화라 이후 threadId 변경·부모 리렌더로 다시 채워지지 않는다(한 번만 미리 채움).
  const [draft, setDraft] = useState(() => seedFromCompose(initialCompose).draft);
  const [composeTooLong, setComposeTooLong] = useState(() => seedFromCompose(initialCompose).tooLong);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // story #4008 CHANGES(PO 지적 ①, 2026-09-17) — reload()가 직접 호출하는 loadMessages는
  // React 이펙트가 아니라 그 cleanup(cancelled=true)을 아무도 안 불러준다 — 재연결으로
  // A 재조회가 진행 中일 때 threadId가 B로 바뀌면, 늦게 도착한 A 응답이 B 화면에 그대로
  // setMessages된다. "지금 보고 있는 대화"를 ref로 따로 들고 응답이 그 대화 것이 맞는지
  // 매번 대조한다(effect 재실행·언마운트로 끊기는 cancelled 플래그보다 imperative 호출
  // 경로까지 균일하게 보호).
  const activeThreadIdRef = useRef(threadId);
  useEffect(() => { activeThreadIdRef.current = threadId; }, [threadId]);

  // story #4008 CHANGES(유나 design·PO 지적, 2026-09-17) — 재연결·탭 복귀마다 이 화면이
  // 스켈레톤으로 순간 비워졌다: reload()가 이 함수를 그대로 불러 매번 setMessages(null)부터
  // 했기 때문(레일 쪽 handleThreadMessage는 성공 때만 교체해 안 비워지는 것과 대조).
  // `silent`(reload 전용)이면 기존 messages를 유지한 채 뒤에서 받아 교체하고, 실패해도
  // 기존 화면을 그대로 둔다(에러 상태로 안 바꿈) — 스켈레톤은 첫 로드·대화 전환(threadId
  // 변경으로 이 콜백 자체가 재생성될 때)에만 뜬다.
  const loadMessages = useCallback((options?: { silent?: boolean }) => {
    let cancelled = false;
    const requestThreadId = threadId;
    if (!options?.silent) {
      setMessages(null);
      setLoadError(false);
    }
    fetchWithAuth(`/api/conversations/${requestThreadId}/messages`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: ChatMessage[] }) => {
        if (cancelled || activeThreadIdRef.current !== requestThreadId) return;
        const fetched = json.data ?? [];
        // story #4008 CHANGES(PO 지적 ②) — silent(reload)는 통째 교체가 아니라 id 기준
        // 병합(레거시 chat-view.tsx의 mergeBackfilledMessages와 동형 원칙). 재조회가 도는
        // 동안 도착한 실시간 메시지(receiveMessage→addMessage)는 이 스냅숏(조회 시작 시점
        // 기준)보다 최신이라 fetch 응답엔 없을 수 있는데, 통째 교체하면 그 메시지가
        // 사라진다(AC4 「따라잡기」가 오히려 잃는 역설).
        let finalList: ChatMessage[] = fetched;
        if (options?.silent) {
          setMessages((prev) => {
            if (!prev) { finalList = fetched; return fetched; }
            const byId = new Map(prev.map((m) => [m.id, m] as const));
            for (const m of fetched) byId.set(m.id, m);
            finalList = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
            return finalList;
          });
        } else {
          setMessages(fetched);
        }
        // story #3972 — 최근 것부터 훑어 첫 artifact 참조를 「열린 산출물」로(맥락 패널).
        // story #3990 — 같은 한 번의 역순회에서 첫 story/task 참조도 같이 뽑는다(「근거」·
        // 「이력」 스코프, #3972와 동일 "가장 최근 참조 1개" 규칙 — 재순회 0).
        let latestArtifactId: string | null = null;
        let latestWorkItemRef: { type: 'story' | 'task'; id: string } | null = null;
        for (let i = finalList.length - 1; i >= 0; i -= 1) {
          const refs = finalList[i]?.references ?? [];
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
        if (cancelled || activeThreadIdRef.current !== requestThreadId) return;
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
      <div className="shrink-0 border-t border-border">
        {composeTooLong ? (
          // story #4028 AC3 — 첫 지시가 상한을 넘어 미리 채우지 못했을 때 안내(자르지
          // 않음). 대화는 이미 열려 있으니 「직접 적어 주세요」로만 안내하고, 사람이
          // 입력을 시작하면(onChange) 소임을 다해 지운다.
          <p role="status" className="px-3 pt-2.5 text-xs text-muted-foreground" data-testid="chat-v3-compose-too-long">
            {t('composeTooLongNotice')}
          </p>
        ) : null}
        <div className="flex items-center gap-2 p-3">
        <Input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (composeTooLong) setComposeTooLong(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
          placeholder={t('instructionPlaceholder', { agent: agentName })}
          aria-label={t('instructionPlaceholder', { agent: agentName })}
          data-testid="chat-v3-compose-input"
        />
        <Button size="sm" disabled={!draft.trim() || sending} onClick={() => void handleSend()} data-testid="chat-v3-send-action">
          {t('sendAction')}
        </Button>
        </div>
      </div>
    </section>
  );
});
