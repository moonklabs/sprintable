'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, MessageSquare, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { NewConversationModal } from './new-conversation-modal';
import { useChatSse } from '@/hooks/use-chat-sse';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

interface Participant {
  member_id: string;
  name: string | null;
  avatar_url?: string | null;
  type?: 'agent' | 'human';
}

interface ConversationItem {
  id: string;
  type: 'dm' | 'group';
  title: string | null;
  latest_message: { content: string; created_at: string } | null;
  updated_at: string;
  unread_count?: number;
  participants?: Participant[];
}

interface ChatListViewProps {
  projectId: string;
  currentTeamMemberId: string;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return '어제';
  if (diffDays < 7) return `${diffDays}일 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function formatParticipantNames(
  participants: Participant[],
  currentMemberId: string,
  type: 'dm' | 'group',
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const others = participants.filter((p) => p.member_id !== currentMemberId);
  if (others.length === 0) return type === 'dm' ? 'DM' : t('groupSection');
  if (type === 'dm') return others[0]?.name ?? '?';
  const MAX = 3;
  if (others.length <= MAX) return others.map((p) => p.name ?? '?').join(', ');
  const visible = others.slice(0, MAX).map((p) => p.name ?? '?').join(', ');
  return `${visible} ${t('participantsOthers', { count: others.length - MAX })}`;
}

function getOtherParticipants(participants: Participant[], currentMemberId: string): Participant[] {
  return participants.filter((p) => p.member_id !== currentMemberId);
}

function hasAgentParticipant(participants: Participant[]): boolean {
  return participants.some((p) => p.type === 'agent');
}

function ConversationRow({
  conv,
  currentMemberId,
  isAgentConv,
  onClick,
}: {
  conv: ConversationItem;
  currentMemberId: string;
  isAgentConv?: boolean;
  onClick: () => void;
}) {
  const t = useTranslations('chats');

  const displayName = conv.title ??
    (conv.participants && conv.participants.length > 0
      ? formatParticipantNames(conv.participants, currentMemberId, conv.type, t)
      : conv.type === 'dm' ? t('dmWith') : t('groupSection'));

  const preview = conv.latest_message?.content ?? t('noMessages');
  const time = conv.latest_message?.created_at ?? conv.updated_at;
  const unread = conv.unread_count ?? 0;

  const avatarInitial = !isAgentConv && conv.type === 'dm' && conv.participants
    ? (conv.participants.find((p) => p.member_id !== currentMemberId)?.name?.slice(0, 2) ?? 'DM')
    : null;

  const others = conv.participants ? getOtherParticipants(conv.participants, currentMemberId) : [];
  const isAgentInConv = conv.participants ? hasAgentParticipant(conv.participants) : false;
  const agentCount = others.filter((p) => p.type === 'agent').length;

  const participantLayer = conv.participants && conv.participants.length > 0 ? (
    conv.type === 'dm' ? (
      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1 py-0.5 font-medium text-muted-foreground">{t('you')}</span>
        <span>↔</span>
        <span className="max-w-[80px] truncate rounded bg-muted px-1 py-0.5 font-medium text-muted-foreground">
          {others[0]?.name ?? '...'}
        </span>
        {isAgentInConv && (
          <span className="flex-shrink-0 rounded border border-brand/30 bg-brand/12 px-1.5 py-0.5 text-[10px] font-medium text-brand-strong">
            {t('agent')}
          </span>
        )}
      </div>
    ) : (
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <div className="flex -space-x-1.5">
          {others.slice(0, 3).map((p) => (
            <div
              key={p.member_id}
              className="relative flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background"
            >
              {p.name?.slice(0, 1) ?? '?'}
              {p.type === 'agent' && (
                <span className="absolute -bottom-px -right-px h-[6px] w-[6px] rounded-full bg-brand-strong ring-1 ring-background" />
              )}
            </div>
          ))}
          {others.length > 3 && (
            <div className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background">
              +{others.length - 3}
            </div>
          )}
        </div>
        <span className="truncate">
          {isAgentInConv && agentCount > 0
            ? t('agentCount', { count: agentCount })
            : `${t('personCount', { count: others.length + 1 })} · ${others.slice(0, 2).map((p) => p.name ?? '?').join(', ')}${others.length > 2 ? ` ${t('participantsOthers', { count: others.length - 2 })}` : ''}`
          }
        </span>
      </div>
    )
  ) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-muted/60 active:bg-muted"
    >
      {/* Avatar */}
      <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium ${
        isAgentConv
          ? 'bg-warning-tint text-warning'
          : conv.type === 'dm'
            ? 'bg-primary/15 text-primary'
            : 'bg-info/15 text-info'
      }`}>
        {isAgentConv
          ? <Bot className="h-4 w-4" />
          : conv.type === 'dm' && avatarInitial
            ? avatarInitial
            : conv.type === 'dm'
              ? <MessageSquare className="h-4 w-4" />
              : <Users className="h-4 w-4" />}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">{formatTime(time)}</span>
        </div>
        {participantLayer}
        <div className="flex items-center justify-between gap-1">
          <p className="truncate text-xs text-muted-foreground">{preview}</p>
          {unread > 0 && (
            <span className="flex-shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function applyConversationMessageUpdate(
  prev: ConversationItem[],
  payload: { conversation_id?: string; content?: string; created_at?: string },
  onRefetch: () => void,
): ConversationItem[] {
  const { conversation_id, content, created_at } = payload;
  if (!conversation_id) return prev;
  const idx = prev.findIndex((c) => c.id === conversation_id);
  if (idx === -1) {
    onRefetch();
    return prev;
  }
  const updated = [...prev];
  const item = { ...updated[idx]! };
  if (content && created_at) {
    item.latest_message = { content, created_at };
    item.updated_at = created_at;
    item.unread_count = (item.unread_count ?? 0) + 1;
  }
  updated.splice(idx, 1);
  return [item, ...updated];
}

const PAGE_LIMIT = 30;

export function ChatListView({ projectId, currentTeamMemberId, open, onOpenChange }: ChatListViewProps) {
  const t = useTranslations('chats');
  const router = useRouter();
  // perf(17960f86): role 은 DashboardContext(서버 /api/v2/me 투영)에서 — 채팅 진입마다 `/api/me`
  // 재호출하던 round-trip 제거. /me checkRole 과 동일한 effective role 이라 게이트 의미 보존.
  const { role } = useDashboardContext();
  const isAdminOrOwner = role === 'admin' || role === 'owner';
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [allConversations, setAllConversations] = useState<ConversationItem[]>([]);
  // agent 탭(allConversations·include_agent_conversations) 첫 활성화 1회만 fetch 하기 위한 가드.
  const agentLoadedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [myOffset, setMyOffset] = useState(0);
  const [myTotal, setMyTotal] = useState(0);
  const [agentOffset, setAgentOffset] = useState(0);
  const [agentTotal, setAgentTotal] = useState(0);
  const [internalShowModal, setInternalShowModal] = useState(false);
  const showModal = open !== undefined ? open : internalShowModal;
  const setShowModal = onOpenChange ?? setInternalShowModal;

  const convsRef = useRef(conversations);
  useEffect(() => { convsRef.current = conversations; }, [conversations]);

  // 전환 in-flight 경합 가드(RC): fetch 응답 적용 시점에 여전히 같은 프로젝트인지 검증해 stale 응답을
  // drop 한다. render 단계 동기라 async resolve 시 항상 최신 projectId 를 가리킨다(assignee last-write-wins 동류).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const fetchConversations = useCallback(async (nextOffset = 0, append = false) => {
    try {
      const res = await fetch(
        `/api/conversations?project_id=${projectId}&limit=${PAGE_LIMIT}&offset=${nextOffset}`
      );
      if (!res.ok) return;
      const json = await res.json() as { data: ConversationItem[]; total: number };
      if (projectId !== projectIdRef.current) return; // 전환됨 — stale 응답 drop(현 화면 안 덮음)
      const items = json.data ?? [];
      setConversations((prev) => append ? [...prev, ...items] : items);
      setMyOffset(nextOffset + items.length);
      setMyTotal(json.total ?? 0);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [projectId]);

  const fetchAllConversations = useCallback(async (nextOffset = 0, append = false) => {
    const res = await fetch(
      `/api/conversations?project_id=${projectId}&include_agent_conversations=true&limit=${PAGE_LIMIT}&offset=${nextOffset}`
    );
    if (!res.ok) return;
    const json = await res.json() as { data: ConversationItem[]; total: number };
    if (projectId !== projectIdRef.current) return; // 전환됨 — stale 응답 drop(B 화면 안 덮음)
    const items = json.data ?? [];
    setAllConversations((prev) => append ? [...prev, ...items] : items);
    setAgentOffset(nextOffset + items.length);
    setAgentTotal(json.total ?? 0);
  }, [projectId]);

  useEffect(() => { void fetchConversations(0, false); }, [fetchConversations]);

  // perf(17960f86): agent 탭("전체/에이전트", include_agent_conversations=true)은 비기본 탭이라
  // mount 시 eager fetch(측정 ~663ms 낭비) 하지 않고, 사용자가 탭을 처음 열 때 1회만 lazy 로드.
  const loadAgentConversationsOnce = useCallback(() => {
    if (agentLoadedRef.current) return;
    agentLoadedRef.current = true;
    void fetchAllConversations(0, false);
  }, [fetchAllConversations]);

  // 프로젝트 전환 시 agent 탭 stale 방지(RC): ref-guard 가 re-render 에 안 리셋되므로 projectId 변경마다
  // 명시 리셋 + agent 리스트 클리어. 이미 열려있던 탭이면 새 프로젝트로 재로드(기존 자동 refetch 동작 보존),
  // 한 번도 안 연 탭이면 lazy 유지. 마운트(첫 projectId)엔 wasLoaded=false 라 무fetch.
  useEffect(() => {
    const wasLoaded = agentLoadedRef.current;
    agentLoadedRef.current = false;
    setAllConversations([]);
    setAgentOffset(0);
    setAgentTotal(0);
    if (wasLoaded) loadAgentConversationsOnce();
  }, [projectId, loadAgentConversationsOnce]);

  const handleConversationMessage = useCallback((payload: { conversation_id?: string; content?: string; created_at?: string }) => {
    setConversations((prev) => applyConversationMessageUpdate(prev, payload, () => void fetchConversations(0, false)));
    // agent 탭을 아직 안 연 상태에선 allConversations 를 reactive 로드하지 않는다(lazy 유지) —
    // 탭 첫 활성화 시 loadAgentConversationsOnce 가 최신본을 받으므로 누락 없음.
    if (agentLoadedRef.current) {
      setAllConversations((prev) => applyConversationMessageUpdate(prev, payload, () => void fetchAllConversations(0, false)));
    }
  }, [fetchConversations, fetchAllConversations]);

  useChatSse({
    currentTeamMemberId,
    onConversationMessage: handleConversationMessage,
  });

  const handleCreated = (conversationId: string) => {
    setShowModal(false);
    router.push(`/chats/${conversationId}`);
  };

  const dmConvs = conversations.filter((c) => c.type === 'dm');
  const groupConvs = conversations.filter((c) => c.type === 'group');

  const myConvIds = new Set(conversations.map((c) => c.id));
  const agentOnlyConvs = allConversations.filter((c) => !myConvIds.has(c.id));

  const myConversationList = loading ? (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground">불러오는 중…</p>
    </div>
  ) : conversations.length === 0 ? (
    <div className="flex h-full items-center justify-center">
      <EmptyState title={t('noConversations')} description={t('startNewConversation')} className="w-full max-w-xs" />
    </div>
  ) : (
    <div className="space-y-4">
      {dmConvs.length > 0 && (
        <div>
          <p className="mb-1 px-3 text-[11px] font-medium text-muted-foreground">
            {t('dmSection')}
          </p>
          {dmConvs.map((conv) => (
            <ConversationRow key={conv.id} conv={conv} currentMemberId={currentTeamMemberId} onClick={() => router.push(`/chats/${conv.id}`)} />
          ))}
        </div>
      )}
      {groupConvs.length > 0 && (
        <div>
          <p className="mb-1 px-3 text-[11px] font-medium text-muted-foreground">
            {t('groupSection')}
          </p>
          {groupConvs.map((conv) => (
            <ConversationRow key={conv.id} conv={conv} currentMemberId={currentTeamMemberId} onClick={() => router.push(`/chats/${conv.id}`)} />
          ))}
        </div>
      )}
      {conversations.length < myTotal && (
        <button
          type="button"
          onClick={() => { setLoadingMore(true); void fetchConversations(myOffset, true); }}
          disabled={loadingMore}
          className="w-full rounded-lg py-2 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
        >
          {loadingMore ? '불러오는 중…' : `더 보기 (${myTotal - conversations.length}건)`}
        </button>
      )}
    </div>
  );

  const agentConversationList = agentOnlyConvs.length === 0 ? (
    <div className="flex h-full items-center justify-center">
      <EmptyState title={t('noAgentConversations')} description="" className="w-full max-w-xs" />
    </div>
  ) : (
    <div>
      <p className="mb-1 px-3 text-[11px] font-medium text-muted-foreground">
        {t('agentSection')}
      </p>
      {agentOnlyConvs.map((conv) => (
        <ConversationRow key={conv.id} conv={conv} currentMemberId={currentTeamMemberId} isAgentConv onClick={() => router.push(`/chats/${conv.id}`)} />
      ))}
      {allConversations.length < agentTotal && (
        <button
          type="button"
          onClick={() => void fetchAllConversations(agentOffset, true)}
          className="w-full rounded-lg py-2 text-xs text-muted-foreground transition hover:text-foreground"
        >
          더 보기 ({agentTotal - allConversations.length}건)
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {isAdminOrOwner ? (
        <Tabs defaultValue="my" onValueChange={(v) => { if (v === 'agent') loadAgentConversationsOnce(); }} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-4 mt-2 w-auto self-start">
            <TabsTrigger value="my">{t('myChatsTab')}</TabsTrigger>
            <TabsTrigger value="agent">{t('agentChatsTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="my" className="flex-1 overflow-y-auto px-2 py-2">
            {myConversationList}
          </TabsContent>
          <TabsContent value="agent" className="flex-1 overflow-y-auto px-2 py-2">
            {agentConversationList}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {myConversationList}
        </div>
      )}

      {showModal && (
        <NewConversationModal
          projectId={projectId}
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
