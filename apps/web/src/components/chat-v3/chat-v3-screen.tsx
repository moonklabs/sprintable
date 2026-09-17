'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe, type Me } from './use-me';
import { ChatV3ThreadRail, type ChatV3Thread } from './chat-v3-thread-rail';
import { ChatV3Messages, type ChatV3MessagesHandle } from './chat-v3-messages';
import { ChatV3ContextPanel } from './chat-v3-context-panel';
import { useTodaySnapshot } from '@/components/org-briefing/use-today-snapshot';
import { useChatSse, type SseConversationReadPayload } from '@/hooks/use-chat-sse';

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
export function ChatV3Screen({ todayV3Enabled }: { todayV3Enabled: boolean }) {
  // 페드루 PO 정렬(2026-09-17 02:10Z) — nav 「오늘」의 OFF 폴백은 nav-config.ts의
  // 「오늘」 zone 정본 경로(zoneNow) /org-briefing(이벤트 카드 서명·관련 링크는
  // "결정할 것" 맥락이라 /gates/{id}·/inbox 그대로 — 이 줄만 정렬).
  const todayHref = todayV3Enabled ? '/today' : '/org-briefing';
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const locale = useLocale();
  // story #4018(AC1 PO 확定 2026-09-17) — 특정 대화 주소는 쿼리(`?conversation=<id>`),
  // 경로 세그먼트 아님(둘 다 RESERVED_FIRST_SEGMENTS/proxy.ts엔 안전 — 첫 세그먼트
  // 'chat'만 보는 로직이라 — 하지만 PO가 AC3 이유로 쿼리를 확定: 경로 세그먼트면
  // 대화를 고를 때마다 페이지 자체가 바뀌어 화면 상태·목록이 다시 마운트될 위험,
  // 쿼리는 같은 페이지에서 인자만 바뀐다).
  const router = useRouter();
  const pathname = usePathname();
  const conversationParam = useSearchParams().get('conversation');
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
  // story #4008 CHANGES 2 — 대화 열의 SSE 구독을 없애고 이 화면의 단일 useChatSse가
  // 대신 밀어준다(위 import 주석 참고). ref는 선택 스레드가 바뀌어도 useCallback
  // 재생성이 필요 없다(안정 참조 — mux 재구독 유발 0).
  const messagesRef = useRef<ChatV3MessagesHandle>(null);
  // story #4018 — 인자 없는 첫 진입의 기본 선택(목록 첫 대화)은 딱 한 번만 정한다.
  // threads 배열은 SSE 재정렬(#4008 AC3)로 마운트 뒤에도 참조가 계속 바뀌는데, 그때마다
  // "첫 대화"를 다시 골라 URL을 갈아치우면 사용자가 다른 대화를 보고 있어도 실시간
  // 트래픽만으로 선택이 튀는 회귀가 난다.
  const didDefaultSelectRef = useRef(false);
  // story #4018 CHANGES 1(PO 지적) — 목록 콜(`GET /api/conversations`)엔 limit이 없어
  // BE 기본 30건만 온다(conversations.py:1453). 딥링크가 그 30건 밖(예: 알림으로 들어온
  // 오래된 대화)을 가리키면 `threads.find()`가 못 찾아 멀쩡한 대화도 "열 수 없어요"로
  // 오판정됐다 — 목록에 없으면 바로 「없음」으로 단정하지 않고 단건 조회
  // (`GET /api/conversations/{id}`, story #2009가 이미 이 갭을 위해 participants까지
  // 실어 준다)로 한 번 더 확인한다.
  const [directConversation, setDirectConversation] = useState<ChatV3Thread | null>(null);
  const [directConversationStatus, setDirectConversationStatus] = useState<'idle' | 'loading' | 'unavailable' | 'error'>('idle');
  const directFetchedIdRef = useRef<string | null>(null);

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
        setThreads(json.data ?? []);
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

  // story #4018 CHANGES 1 — 30건 캡 밖 대화 단건 조회. 404/403은 「열 수 없어요」(AC2,
  // 존재/권한을 안 가름) · 그 밖의 실패(5xx·네트워크)는 로드 오류로 갈라 "없는 대화"로
  // 단정하지 않는다(PO 지시). 재시도(아래 retryDirectConversation)도 이 함수를 그대로 씀.
  const fetchDirectConversation = useCallback((id: string) => {
    directFetchedIdRef.current = id;
    setDirectConversationStatus('loading');
    setDirectConversation(null);
    return fetchWithAuth(`/api/conversations/${id}`)
      .then(async (res) => {
        if (res.status === 404 || res.status === 403) { setDirectConversationStatus('unavailable'); return; }
        if (!res.ok) { setDirectConversationStatus('error'); return; }
        const data = (await res.json()) as ChatV3Thread;
        setDirectConversation({ ...data, latest_message: data.latest_message ?? null, unread_count: data.unread_count ?? 0 });
        setDirectConversationStatus('idle');
      })
      .catch(() => { setDirectConversationStatus('error'); });
  }, []);

  useEffect(() => {
    if (!threads || !selectedId) return;
    if (threads.some((th) => th.id === selectedId)) {
      // 지금 선택이 30건 목록 안이면(정상 경로) 이전 선택의 단건 조회 잔여 상태를 청소.
      // 정적분석 오탐(위 loadConversations 마운트 effect·conversationParam 동기화 effect와
      // 동일 사유 — connect-step.tsx·now-strip.tsx 관례).
      if (directFetchedIdRef.current !== null) {
        directFetchedIdRef.current = null;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDirectConversation(null);
        setDirectConversationStatus('idle');
      }
      return;
    }
    if (directFetchedIdRef.current === selectedId) return; // 이 id는 이미 조회 완료(성공/실패 무관).
    void fetchDirectConversation(selectedId);
  }, [threads, selectedId, fetchDirectConversation]);

  const retryDirectConversation = useCallback(() => {
    if (selectedId) void fetchDirectConversation(selectedId);
  }, [selectedId, fetchDirectConversation]);

  // story #4018 AC1/AC3 — 주소의 `conversation` 인자가 정본. 있으면(존재/권한 무관, id
  // 그대로) 그 값을 선택 상태로 반영 — 목록에 없으면 아래 selectedThread가 undefined가
  // 돼 렌더가 「이 대화를 열 수 없어요」로 가른다(PO 지시: 잘못된 id도 주소에 그대로
  // 둔다 — 새로고침해도 같은 안내). 인자가 없으면 목록 첫 대화를 딱 한 번만 기본
  // 선택하고 `replace`로 주소에 반영(뒤로가기 기록 안 쌓임, PO 지시 1).
  useEffect(() => {
    if (!threads) return;
    if (conversationParam) {
      // 주소(외부 시스템)를 선택 상태(React state)로 동기화하는 자리 — connect-step.tsx·
      // now-strip.tsx와 같은 관례로 정적분석이 "effect 안 setState"를 오탐한다(위 loadConversations
      // 마운트 effect와 동일 사유). handleSelectThread에서도 같은 selectedId를 즉시(router.push의
      // 내비게이션 완료를 안 기다리고) 반영해야 클릭 응답이 매끄러워 렌더 시점 파생으로 못 바꾼다.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedId(conversationParam);
      return;
    }
    if (didDefaultSelectRef.current) return;
    didDefaultSelectRef.current = true;
    const defaultId = threads[0]?.id ?? null;
    setSelectedId(defaultId);
    if (defaultId) router.replace(`${pathname}?conversation=${defaultId}`);
  }, [threads, conversationParam, pathname, router]);

  // story #4018 AC3 — 사람이 직접 고르면 주소를 push(뒤로가기 = 이전 대화). 기본
  // 선택(위 effect)과 달리 이건 항상 새 기록을 쌓는다 — 그게 사용자 의도적 이동이므로.
  const handleSelectThread = useCallback((id: string) => {
    setSelectedId(id);
    router.push(`${pathname}?conversation=${id}`);
  }, [pathname, router]);

  // story #4008 AC3 — 스레드 레일 실시간(chat-list-view.tsx applyConversationMessageUpdate와
  // 동형: 미리보기·시각 갱신 + 최근 순 재정렬). 대상 스레드가 목록에 없으면(새 대화 등)
  // 통째 재조회로 폴백. 「지금 열린 스레드는 안읽음 점 안 켬」(AC3 명시 문구) — legacy처럼
  // mark-read SSE 왕복으로 되돌리는 대신 이 화면 규모에 맞게 즉시 스킵(신규 mark-read
  // 배선은 이 스토리 범위 밖).
  const handleThreadMessage = useCallback((payload: Record<string, unknown>) => {
    const conversationId = (payload.conversation_id ?? payload.id) as string | undefined;
    const content = payload.content as string | undefined;
    const createdAt = payload.created_at as string | undefined;
    if (!conversationId) return;
    // story #4008 CHANGES 2 — 이 화면(선택된 스레드)에 온 메시지는 대화 열로도
    // 밀어준다(그 컴포넌트는 더 이상 자기 useChatSse가 없다 — 위 import 주석).
    if (conversationId === selectedId) messagesRef.current?.receiveMessage(payload);
    setThreads((prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((th) => th.id === conversationId);
      if (idx === -1) { if (me) loadConversations(me); return prev; }
      const updated = [...prev];
      const item = { ...updated[idx]! };
      if (content && createdAt) {
        item.latest_message = { content, created_at: createdAt };
        if (conversationId !== selectedId) item.unread_count = (item.unread_count ?? 0) + 1;
      }
      updated.splice(idx, 1);
      return [item, ...updated];
    });
  }, [selectedId, loadConversations, me]);

  const handleThreadRead = useCallback((payload: SseConversationReadPayload) => {
    setThreads((prev) =>
      prev ? prev.map((th) => (th.id === payload.conversation_id ? { ...th, unread_count: payload.unread_count } : th)) : prev,
    );
  }, []);

  const handleThreadReconnect = useCallback(() => {
    if (me) loadConversations(me);
    // story #4008 CHANGES 2 — 대화 열도 같은 재연결 신호로 따라잡는다(그 컴포넌트
    // 자기 useChatSse가 없어져 onReconnect를 직접 못 받는다 — 위 import 주석).
    messagesRef.current?.reload();
  }, [me, loadConversations]);

  useChatSse({
    currentTeamMemberId: me?.id,
    onConversationMessage: handleThreadMessage,
    onConversationRead: handleThreadRead,
    onReconnect: handleThreadReconnect,
  });

  // 교차 PR 드리프트(유나 점검표 1c6a0ced, 항목 4) — 오류 자리에 보이는 「다시
  // 시도」. me 자체가 실패면 me부터, me는 있는데 대화 목록만 실패면 그것만.
  const retryLoad = () => {
    if (meError) retryMe();
    else if (me) { setThreads(null); loadConversations(me); }
  };

  // story #4018 CHANGES 1 — 30건 목록에 없으면 단건 조회 결과(directConversation)로 폴백.
  const selectedThread = threads?.find((th) => th.id === selectedId) ?? directConversation;
  const otherParticipant = selectedThread?.participants.find((p) => p.member_id !== me?.id) ?? selectedThread?.participants[0];
  const agentName = otherParticipant?.name ?? t('unknownParticipant');

  return (
    <div className="flex h-screen min-h-0 bg-muted/20" data-testid="chat-v3-screen">
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-border bg-card p-3">
        <nav className="mt-1 flex flex-col gap-0.5">
          <Link href={todayHref} className="rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted">{t('navToday')}</Link>
          <span className="rounded-md bg-primary/10 px-2.5 py-2 text-sm font-medium text-primary">{t('navChats')}</span>
        </nav>
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
        ) : threads.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('threadRailEmpty')}</p>
          </div>
        ) : (
          <>
            <ChatV3ThreadRail threads={threads} meId={me.id} selectedId={selectedId} onSelect={handleSelectThread} />
            {selectedId === null ? (
              // story #4018 — 기본 선택 effect가 아직 안 돈 찰나(같은 커밋 안에서 곧
              // 해소됨). threads.length>0이 이미 보장돼 있어 이 상태는 일시적이다.
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-muted-foreground">{t('threadRailEmpty')}</p>
              </div>
            ) : selectedThread ? (
              <>
                <ChatV3Messages
                  ref={messagesRef}
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
            ) : directConversationStatus === 'error' ? (
              // story #4018 CHANGES 1 — 단건 조회 자체가 실패(5xx·네트워크)한 경우는
              // "없는 대화"로 단정하지 않는다(PO 지시) — 일반 로드 오류로 갈라 재시도 제공.
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
                <Button size="sm" variant="outline" onClick={retryDirectConversation} data-testid="chat-v3-conversation-retry">{tc('retry')}</Button>
              </div>
            ) : directConversationStatus === 'unavailable' ? (
              // story #4018 AC2(유나 시안 703ed02d §4018) — 없는/권한 없는 대화 id.
              // 존재 여부를 안 가른다(같은 문장) · 목록(레일)은 그대로 · 계열색 0.
              <div className="flex flex-1 flex-col items-center justify-center gap-1 p-5 text-center" data-testid="chat-v3-conversation-unavailable">
                <p className="text-sm font-medium text-foreground">{t('conversationUnavailableTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('conversationUnavailableDescription')}</p>
              </div>
            ) : (
              // 'idle'/'loading' — 30건 밖 id의 단건 조회가 아직 진행 中(찰나~짧은 로딩).
              <div className="flex flex-1 flex-col gap-3 p-5" data-testid="chat-v3-conversation-checking" aria-hidden="true">
                <Skeleton className="h-12 w-full" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
