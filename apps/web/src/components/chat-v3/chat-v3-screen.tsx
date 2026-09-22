'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe, type Me } from './use-me';
import { ChatV3ThreadRail, type ChatV3Thread } from './chat-v3-thread-rail';
import { ChatV3Messages } from './chat-v3-messages';
import { ChatV3ContextPanel } from './chat-v3-context-panel';
import { useTodaySnapshot } from '@/components/org-briefing/use-today-snapshot';
import { NavV3ItemList } from '@/components/nav/nav-v3-item-list';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags } from '@/lib/nav-v3-destinations';

/**
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N·FE) — 시안 ②(artifact c707a913)
 * 3단 허브 첫 화면. 그라운딩(#3971 doc) + 페드루 PO 판정(부재 8) 그대로:
 *  - 스레드 레일: `GET /api/conversations?include_agent_conversations=true`
 *    (owner/admin 제한은 BE 그대로 — 비-admin은 자기 대화만, 새 인가 0).
 *  - 대화 열: 기존 메시지 프록시+임베드 칩+전송 재사용(`chat-v3-messages.tsx`).
 *  - 맥락 패널: 열린 산출물(references 파생)·관련(오늘 스냅샷 역조회)·근거·이력
 *    (references 최근 story/task 파생 스코프로 기존 evidence·activity-logs API,
 *    story #3990 — #3971 부재 4·5 정정으로 새 BE 0) 전부 실값.
 * 옛 `/chats`·`ChatListView`·`ChatView`·`approval-request-card.tsx` 전부 무접촉
 * (재사용은 import/조각뿐, 그 파일들 자체는 1줄도 안 건드림).
 */
export function ChatV3Screen({ flags = DEFAULT_NAV_V3_FLAGS }: { flags?: NavV3Flags }) {
  // story #4004 — 「오늘」 목적지는 더 이상 이 화면이 재조립하지 않는다(nav-v3-item-list.tsx가
  // resolveNavV3Destinations 그대로 씀). 이벤트 카드 서명·관련 링크는 "결정할 것" 맥락이라
  // 여전히 /gates/{id}·/inbox 자기 fallback을 쓴다(chat-v3-event-card.tsx·
  // chat-v3-context-panel.tsx 참고, 목적지 모듈이 정할 대상이 아님 — 「오늘」 nav 항목과
  // 다른 결정).
  const todayV3Enabled = flags.todayV3Enabled;
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const locale = useLocale();
  const { me, error: meError, retry: retryMe } = useMe();
  // 페드루 PO 지시(2026-09-17 00:08Z, PR #4370 CHANGES) — 오늘 스냅샷은 여기서
  // 1콜만(맥락 패널 「관련」·이벤트 카드 「서명」 막다른 길 방지 둘 다 이 캐시 공유).
  const { data: todaySnapshot } = useTodaySnapshot();
  const needsMe = todaySnapshot?.needsMe ?? [];
  const [threads, setThreads] = useState<ChatV3Thread[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  // story #3990 — 「근거」·「이력」 절이 스코프할 일(work item). chat-v3-messages.tsx가
  // openArtifactId와 같은 파생 루프에서 같이 뽑아 올린다.
  const [workItemRef, setWorkItemRef] = useState<{ type: 'story' | 'task'; id: string } | null>(null);

  const loadConversations = useCallback((currentMe: Me) => {
    let cancelled = false;
    setLoadError(false);
    // 페드루 PO CHANGES C1(2026-09-17 00:04Z, PR #4370) — include_agent_conversations=true는
    // owner/admin 전용(conversations.py:1462-1467, 그 외 role은 403) — role 무관하게 항상
    // 붙이면 비-admin에게 화면 전체가 "불러오지 못했어요"로 죽는다. role 조건부로만 붙인다.
    const includeAgentConversations = currentMe.role === 'owner' || currentMe.role === 'admin';
    const params = new URLSearchParams({ project_id: currentMe.projectId });
    if (includeAgentConversations) params.set('include_agent_conversations', 'true');
    fetchWithAuth(`/api/conversations?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json: { data?: ChatV3Thread[] }) => {
        if (cancelled) return;
        const list = json.data ?? [];
        setThreads(list);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!me) return;
    // 기존 코드베이스 관례(connect-step.tsx·now-strip.tsx) — fetchWithAuth 마운트-
    // fetch 패턴을 정적분석이 "effect 안 setState"로 오탐하는 자리, disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    return loadConversations(me);
  }, [me, loadConversations]);

  // 교차 PR 드리프트(유나 점검표 1c6a0ced, 항목 4) — 오류 자리에 보이는 「다시
  // 시도」. me 자체가 실패면 me부터, me는 있는데 대화 목록만 실패면 그것만.
  const retryLoad = () => {
    if (meError) retryMe();
    else if (me) { setThreads(null); loadConversations(me); }
  };

  const selectedThread = threads?.find((th) => th.id === selectedId) ?? null;
  const otherParticipant = selectedThread?.participants.find((p) => p.member_id !== me?.id) ?? selectedThread?.participants[0];
  const agentName = otherParticipant?.name ?? t('unknownParticipant');

  return (
    <div className="flex h-screen min-h-0 bg-muted/20" data-testid="chat-v3-screen">
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-border bg-card p-3">
        <NavV3ItemList flags={flags} activeKey="chats" />
      </aside>
      <div className="flex min-w-0 flex-1">
        {loadError || meError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
            <Button size="sm" variant="outline" onClick={retryLoad} data-testid="chat-v3-retry">{tc('retry')}</Button>
          </div>
        ) : !threads || !me ? (
          <div className="flex flex-1 flex-col gap-3 p-5" data-testid="chat-v3-loading" aria-hidden="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
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
                  needsMe={needsMe}
                  todayV3Enabled={todayV3Enabled}
                  onOpenArtifactChange={setOpenArtifactId}
                  onWorkItemRefChange={setWorkItemRef}
                />
                <ChatV3ContextPanel
                  conversationId={selectedThread.id}
                  openArtifactId={openArtifactId}
                  workItemRef={workItemRef}
                  needsMe={needsMe}
                  todayV3Enabled={todayV3Enabled}
                />
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
