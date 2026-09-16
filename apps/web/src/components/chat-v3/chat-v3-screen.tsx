'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { useMe } from './use-me';
import { ChatV3ThreadRail, type ChatV3Thread } from './chat-v3-thread-rail';
import { ChatV3Messages } from './chat-v3-messages';
import { ChatV3ContextPanel } from './chat-v3-context-panel';

/**
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N·FE) — 시안 ②(artifact c707a913)
 * 3단 허브 첫 화면. 그라운딩(#3971 doc) + 페드루 PO 판정(부재 8) 그대로:
 *  - 스레드 레일: `GET /api/conversations?include_agent_conversations=true`
 *    (owner/admin 제한은 BE 그대로 — 비-admin은 자기 대화만, 새 인가 0).
 *  - 대화 열: 기존 메시지 프록시+임베드 칩+전송 재사용(`chat-v3-messages.tsx`).
 *  - 맥락 패널: 열린 산출물(references 파생)·관련(오늘 스냅샷 역조회) 실값,
 *    근거·이력은 자리만(집계 API 부재, #3971 부재 4·5 — BE 별 카드).
 * 옛 `/chats`·`ChatListView`·`ChatView`·`approval-request-card.tsx` 전부 무접촉
 * (재사용은 import/조각뿐, 그 파일들 자체는 1줄도 안 건드림).
 */
export function ChatV3Screen() {
  const t = useTranslations('chatV3');
  const locale = useLocale();
  const me = useMe();
  const [threads, setThreads] = useState<ChatV3Thread[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(me.projectId)}&include_agent_conversations=true`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: ChatV3Thread[] }) => {
        if (cancelled) return;
        const list = json.data ?? [];
        setThreads(list);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [me]);

  const selectedThread = threads?.find((th) => th.id === selectedId) ?? null;
  const otherParticipant = selectedThread?.participants.find((p) => p.member_id !== me?.id) ?? selectedThread?.participants[0];
  const agentName = otherParticipant?.name ?? t('unknownParticipant');

  return (
    <div className="flex h-screen min-h-0 bg-muted/20" data-testid="chat-v3-screen">
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-border bg-card p-3">
        <nav className="mt-1 flex flex-col gap-0.5">
          <Link href="/today" className="rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted">{t('navToday')}</Link>
          <span className="rounded-md bg-primary/10 px-2.5 py-2 text-sm font-medium text-primary">{t('navChats')}</span>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1">
        {loadError ? (
          <div className="flex flex-1 items-center justify-center">
            <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
          </div>
        ) : !threads || !me ? (
          <div className="flex flex-1 items-center justify-center" data-testid="chat-v3-loading" aria-hidden="true" />
        ) : (
          <>
            <ChatV3ThreadRail threads={threads} meId={me.id} selectedId={selectedId} onSelect={setSelectedId} />
            {selectedThread ? (
              <>
                <ChatV3Messages
                  threadId={selectedThread.id}
                  meId={me.id}
                  agentName={agentName}
                  locale={locale}
                  onOpenArtifactChange={setOpenArtifactId}
                />
                <ChatV3ContextPanel conversationId={selectedThread.id} openArtifactId={openArtifactId} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-muted-foreground">{t('threadRailEmpty')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
