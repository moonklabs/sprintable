'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

export function ChatV3Messages({ threadId, meId, agentName, locale, needsMe, todayV3Enabled, onOpenArtifactChange }: {
  threadId: string;
  meId: string;
  agentName: string;
  locale: string;
  needsMe: TodayNeedsMeItem[];
  // story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — 이벤트 카드 서명
  // 버튼도 같은 게이트(TODAY_V3_ENABLED OFF면 /today가 404).
  todayV3Enabled: boolean;
  onOpenArtifactChange: (artifactId: string | null) => void;
}) {
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(() => {
    let cancelled = false;
    setMessages(null);
    setLoadError(false);
    fetchWithAuth(`/api/conversations/${threadId}/messages`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: Record<string, unknown>[] }) => {
        if (cancelled) return;
        // 결함④(3998 PO 지적) — 백엔드는 sender를 중첩(`sender:{id,name}`)으로 내려준다.
        // 예전엔 여기서 raw를 ChatMessage로 그냥 캐스트해 sender_name/created_by가 항상
        // undefined였다(이름 줄 빈칸·isMine 오판) — 레거시 훅과 같은 정규화 함수로 통과.
        const list = (json.data ?? []).map(normalizeToMessage);
        setMessages(list);
        // story #3972 — 최근 것부터 훑어 첫 artifact 참조를 「열린 산출물」로(맥락 패널).
        let latestArtifactId: string | null = null;
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const found = list[i]?.references?.find((r) => r.target_type === 'artifact');
          if (found) { latestArtifactId = found.target_id; break; }
        }
        onOpenArtifactChange(latestArtifactId);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onOpenArtifactChange는 부모가 매 렌더 새로 안 만든다는 계약(useCallback) 가정 밖·threadId 변경 시만 재조회.
  }, [threadId]);

  useEffect(() => loadMessages(), [loadMessages]);

  useEffect(() => {
    // jsdom(테스트 환경)엔 scrollIntoView가 없다 — 방어적 optional call(실 브라우저는 항상 있음).
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages]);

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
      const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
      if (json?.data) setMessages((prev) => [...(prev ?? []), normalizeToMessage(json.data as Record<string, unknown>)]);
    }
  };

  let lastDay: string | null = null;

  return (
    <section className="flex min-w-0 flex-1 flex-col border-r border-border bg-background" data-testid="chat-v3-messages-column">
      {loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
          <Button size="sm" variant="outline" onClick={loadMessages} data-testid="chat-v3-messages-retry">{tc('retry')}</Button>
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
}
