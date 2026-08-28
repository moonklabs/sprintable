'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { NewConversationModal } from './new-conversation-modal';
import { useChatSse, type SseConversationReadPayload } from '@/hooks/use-chat-sse';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { queuePendingToast } from './cross-project-toast-provider';
import { Avatar } from '@/components/shared/avatar';
import { Button } from '@/components/ui/button';
import { NowStrip } from './now-strip';
import { PulseCard } from './pulse-card';

import { fetchWithAuth } from '@/lib/db/client';

interface Participant {
  member_id: string;
  name: string | null;
  avatar_url?: string | null;
  type?: 'agent' | 'human';
  /** story #3106(#3092 후속) — BE `_fetch_conversation_participants`가 이미 싣던 필드(agent만
   * 값, human=null)를 이 타입이 안 받아 그동안 버려지고 있었다. */
  runtime_type?: string | null;
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

// story #2168 PR-② — 현재 프로젝트 밖에서 caller가 참여 중인 최근 대화(BE
// GET /conversations/recent-outside-project, caller last_read_at DESC·최대 5개).
// story #2972 — participants 추가(BE delta). DM 행은 title이 항상 NULL이라 이게 없으면
// FE가 상대 이름을 조립할 재료가 아예 없었다("님과의 대화" 반쪽 문자열 버그의 원인).
interface OutsideProjectConversation {
  id: string;
  type: 'dm' | 'group';
  title: string | null;
  project_id: string;
  project_name: string;
  project_slug: string;
  participants?: Participant[];
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

  const others = conv.participants ? getOtherParticipants(conv.participants, currentMemberId) : [];
  const isAgentInConv = conv.participants ? hasAgentParticipant(conv.participants) : false;
  const agentCount = others.filter((p) => p.type === 'agent').length;
  // story #2968 — 1:1(conv.type==='dm')만 상대가 특정되므로 avatar_url 실사진을 그대로 쓴다
  // (avatar.tsx=정본, story #2887/#2921 — 3단 폴백[이미지→이니셜→아이콘]도 그쪽이 갖고 있다).
  // group은 "그 방을 대표하는 단일 인물"이 없어(다인원) 기존 Users 아이콘을 유지한다.
  //
  // 카디르 QA(#3397, HIGH) — isAgentConv를 조건에 넣으면 agent탭의 group 대화까지 걸려
  // others[0](임의 참가자 1인)을 대표사진처럼 노출했다(agentOnlyConvs 필터가 conv.type을
  // 안 가려 group에도 isAgentConv=true가 붙는다, ChatListView 참고). 순수 conv.type만 본다
  // — isAgentConv는 이름/actorType 폴백에서만 쓴다(agent탭 DM의 상대가 실제 에이전트임을
  // 보강하는 용도, group 판정에는 관여하지 않는다).
  const oneOnOneParticipant = conv.type === 'dm' ? others[0] : null;

  const participantLayer = conv.participants && conv.participants.length > 0 ? (
    conv.type === 'dm' ? (
      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1 py-0.5 font-medium text-muted-foreground">{t('you')}</span>
        <span>↔</span>
        <span className="max-w-[80px] truncate rounded bg-muted px-1 py-0.5 font-medium text-muted-foreground">
          {others[0]?.name ?? '...'}
        </span>
        {/* story #2023 ⓑ: L5(시스템 상태), 브랜드 아님 */}
        {isAgentInConv && (
          // story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙).
          <span className="flex-shrink-0 rounded border border-info/30 bg-info/12 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
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
              {/* story #2023 ⓑ: 죽은 클래스(bg-brand-strong 미매핑)이면서 L5 위반 — info로 교체해 둘 다 닫음 */}
              {p.type === 'agent' && (
                <span className="absolute -bottom-px -right-px h-[6px] w-[6px] rounded-full bg-info ring-1 ring-background" />
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
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="h-auto w-full items-center justify-start gap-3 rounded-lg px-3 py-2.5 text-left font-normal transition hover:bg-muted/60 active:bg-muted"
    >
      {/* story #2968 — 1:1(DM·agent 탭)은 avatar.tsx 정본으로 실사진(3단 폴백은 그 컴포넌트
          책임). group은 특정 1인 사진이 의미가 없어(다인원) 기존 아이콘 자리를 유지한다. */}
      {oneOnOneParticipant ? (
        <Avatar
          name={oneOnOneParticipant.name ?? (isAgentConv ? t('agent') : 'DM')}
          avatarUrl={oneOnOneParticipant.avatar_url ?? null}
          actorType={isAgentConv || oneOnOneParticipant.type === 'agent' ? 'agent' : 'human'}
          size={36}
          runtimeType={(isAgentConv || oneOnOneParticipant.type === 'agent') ? (oneOnOneParticipant.runtime_type ?? null) : null}
        />
      ) : (
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-info/15 text-foreground">
          {conv.type === 'dm' ? <MessageSquare className="h-4 w-4" /> : <Users className="h-4 w-4" />}
        </div>
      )}

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          {/* story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — 대화명=Claim(600)로
              재분류(구조·크기 불변). preview는 이미 text-xs+muted+기본무게(400)라 Body-small
              규칙에 이미 부합 — 무편집. */}
          <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
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
    </Button>
  );
}

// story #2168 PR-② — "다른 프로젝트" 섹션의 항목. ConversationRow(현재 프로젝트 목록)와 다른
// 컴포넌트로 둔다 — BE가 unread_count/latest_message/participants를 안 주고(스펙: 정렬축=내
// last_read_at, 목록 자체가 참여 확인용이지 미리보기용이 아님), 유일한 필수 표기(③ 프로젝트명
// 병기)도 이쪽에만 있다. onClick은 부모가 준다(project 전환+토스트는 목록 상태를 알아야 함).
function OutsideProjectRow({
  conv,
  currentMemberId,
  onClick,
}: {
  conv: OutsideProjectConversation;
  currentMemberId: string;
  onClick: () => void;
}) {
  const t = useTranslations('chats');
  // story #2972 — DM 행 title은 항상 NULL(list_conversations 관례)이라 participants로
  // 조립해야만 상대 이름이 뜬다(ConversationRow와 동일 패턴). BE가 이제 participants를
  // 실어줘(delta) 여기서도 formatParticipantNames를 탈 수 있다 — participants가 비어있는
  // 진짜 무재료 상황만 no-fiction 폴백(dmWith/groupSection, 완결된 단어로 수정됨)으로 떨어진다.
  const displayName = conv.title ??
    (conv.participants && conv.participants.length > 0
      ? formatParticipantNames(conv.participants, currentMemberId, conv.type, t)
      : conv.type === 'dm' ? t('dmWith') : t('groupSection'));

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="h-auto w-full items-center justify-start gap-3 rounded-lg px-3 py-2.5 text-left font-normal transition hover:bg-muted/60 active:bg-muted"
    >
      <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium ${
        conv.type === 'dm' ? 'bg-primary/15 text-primary' : 'bg-info/15 text-info'
      }`}>
        {conv.type === 'dm' ? <MessageSquare className="h-4 w-4" /> : <Users className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        {/* story #2969 §1.3-b(PR-5) — 대화명=Claim(600), ConversationRow와 동일 처방. */}
        <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
        {/* ⭐AC③ — 프로젝트명 병기("왜 여기 있지"를 그 자리서 답한다) */}
        <p className="truncate text-xs text-muted-foreground">{conv.project_name}</p>
      </div>
    </Button>
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

  // story #3178(S3b) AC2 — 「지금」 스트립 vs pulse 카드 합산 불변식(최대 1 expand). 단일
  // 값이라 구조적으로 둘이 동시에 펼쳐질 수 없다(하나를 펼치면 다른 값으로 덮어써 자동 접힘).
  const [expandedSurface, setExpandedSurface] = useState<'strip' | 'pulse' | null>(null);

  // story #2168 PR-② — 프로젝트 밖 최근 대화(최대 5개).
  const [outsideProjectConvs, setOutsideProjectConvs] = useState<OutsideProjectConversation[]>([]);

  const convsRef = useRef(conversations);
  useEffect(() => { convsRef.current = conversations; }, [conversations]);

  // 전환 in-flight 경합 가드(RC): fetch 응답 적용 시점에 여전히 같은 프로젝트인지 검증해 stale 응답을
  // drop 한다. render 단계 동기라 async resolve 시 항상 최신 projectId 를 가리킨다(assignee last-write-wins 동류).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const fetchConversations = useCallback(async (nextOffset = 0, append = false) => {
    try {
      const res = await fetchWithAuth(
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
    const res = await fetchWithAuth(
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

  // story #2168 PR-② — 프로젝트 밖 최근 대화. BE가 이미 인가로 거른 5개만 주므로 페이지네이션
  // 불요. 전환 in-flight 가드는 위 fetchConversations와 동형(stale 응답 drop).
  const fetchOutsideProjectConversations = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/conversations/recent-outside-project?project_id=${projectId}&limit=5`);
      if (!res.ok) return;
      const json = await res.json() as { data?: OutsideProjectConversation[] };
      if (projectId !== projectIdRef.current) return;
      setOutsideProjectConvs(json.data ?? []);
    } catch { /* non-critical — 섹션이 비어도 현재 프로젝트 목록엔 영향 없음 */ }
  }, [projectId]);

  useEffect(() => { void fetchOutsideProjectConversations(); }, [fetchOutsideProjectConversations]);

  // ④ 누르면 프로젝트가 바뀌되 눈에 보이게 — R2 프로젝트 SSOT(project-context-client.ts)가
  // 이미 `?p=`를 탭별 effective project로 승격하므로, 목적지 URL에 `?p={target}`을 실어 보내는
  // 것만으로 헤더·스위처가 그 프로젝트로 실제 전환된다(별도 switch-project 호출 불요 — 이 경로는
  // 명시 project_id를 이미 실은 URL이라 R2 우선순위상 accessible 검증만 통과하면 채택된다).
  // `from`(원 프로젝트)은 대화 상세 페이지의 기존 "← 채팅" 뒤로가기 버튼이 그대로 소비해
  // "고르면 여기로 돌아온다"를 완성한다(새 뒤로가기 UI를 만들지 않는다).
  //
  // ⚠️토스트는 queuePendingToast로 넘긴다(직접 addToast 아님) — 라이브 실측으로 발견: 이 클릭
  // 직후 곧장 router.push하면 이 컴포넌트(ChatListView) 자체가 언마운트되며 로컬 토스트도 화면에
  // 페인트될 새 없이 함께 사라졌다. cross-project-toast-provider.tsx(layout 레벨 상주)가 도착한
  // 페이지에서 대신 띄운다.
  const handleOutsideProjectClick = useCallback((conv: OutsideProjectConversation) => {
    queuePendingToast(t('movedToProjectToast', { name: conv.project_name }));
    // `pn`(대상 프로젝트명)은 실패 화면(권한 회수 등)에서 dashboardContext.projectMemberships가
    // 이미 그 프로젝트를 못 가진 상태일 수 있어(바로 그게 실패 사유) 클릭 시점 값을 실어 보낸다.
    const params = new URLSearchParams({ p: conv.project_id, from: projectId, pn: conv.project_name });
    router.push(`/chats/${conv.id}?${params.toString()}`);
  }, [t, router, projectId]);

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

  // story #1977(트랙B): 다른 탭/기기에서 mark-read → conversation.read SSE(#1976, 본인 타
  // 커넥션 전파)로 이 목록이 열려있는 동안에도 unread 배지가 즉시 서버 truth로 자가정정.
  const handleConversationRead = useCallback((payload: SseConversationReadPayload) => {
    const applyRead = (list: ConversationItem[]) =>
      list.map((c) => (c.id === payload.conversation_id ? { ...c, unread_count: payload.unread_count } : c));
    setConversations(applyRead);
    if (agentLoadedRef.current) setAllConversations(applyRead);
  }, []);

  // story #1978(트랙C) — SSE 드롭 후 놓친 conversation.message_created는 이 목록에 영영
  // 반영 안 됐다(handleConversationMessage는 살아있는 이벤트에만 반응). chat-view.tsx의
  // handleReconnect(fetchMessages 재호출)와 동형 — "재연결됐다"는 신호를 받으면 목록을
  // 통째로 다시 가져와 서버 truth로 백필한다. agent 탭은 이미 연 적 있을 때만(lazy 유지 원칙,
  // loadAgentConversationsOnce와 동일 가드).
  // story #3081 — SSE onReconnect(연결 자체의 재연결)와 아래 visibility/focus 리스너가
  // 근접 시점에 겹쳐 부르면(예: 짧은 네트워크 끊김 직후 탭 포커스 복귀) 같은 재fetch가
  // 중복 실행된다. 결과 자체는 idempotent라 데이터 오염은 없지만 불필요한 API 처칭을
  // 억제한다.
  const lastReconnectFetchAtRef = useRef(0);
  const RECONNECT_COALESCE_MS = 1_000;
  const handleReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectFetchAtRef.current < RECONNECT_COALESCE_MS) return;
    lastReconnectFetchAtRef.current = now;
    void fetchConversations(0, false);
    if (agentLoadedRef.current) void fetchAllConversations(0, false);
  }, [fetchConversations, fetchAllConversations]);

  useChatSse({
    currentTeamMemberId,
    onConversationMessage: handleConversationMessage,
    onConversationRead: handleConversationRead,
    onReconnect: handleReconnect,
  });

  // story #1978(트랙C) — onReconnect(SSE 커넥션 자체의 재연결)와는 다른 축: 탭이 백그라운드에
  // 있는 동안엔 SSE가 안 끊겨도(브라우저가 살려둘 수 있음) 목록이 갱신 안 됐을 수 있다.
  // use-chat-unread-total.ts와 동일 패턴(document.visibilitychange, !document.hidden에서만).
  // story #3081 — 데스크톱 셸(창은 계속 visible)에서 OS 포커스만 잃었다 되찾는 경우
  // visibilitychange는 안 fire하므로 window.focus를 같은 핸들러에 추가 배선한다.
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) handleReconnect();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
    };
  }, [handleReconnect]);

  const handleCreated = (conversationId: string) => {
    setShowModal(false);
    router.push(`/chats/${conversationId}`);
  };

  const dmConvs = conversations.filter((c) => c.type === 'dm');
  const groupConvs = conversations.filter((c) => c.type === 'group');

  const myConvIds = new Set(conversations.map((c) => c.id));
  const agentOnlyConvs = allConversations.filter((c) => !myConvIds.has(c.id));

  const myListContent = loading ? (
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
        <Button
          type="button"
          variant="ghost"
          onClick={() => { setLoadingMore(true); void fetchConversations(myOffset, true); }}
          disabled={loadingMore}
          className="h-auto w-full rounded-lg py-2 text-xs font-normal text-muted-foreground transition hover:text-foreground disabled:opacity-50"
        >
          {loadingMore ? '불러오는 중…' : `더 보기 (${myTotal - conversations.length}건)`}
        </Button>
      )}
    </div>
  );

  // story #2168 PR-② AC② — 현재 목록 **아래** 구분 섹션(현재 목록 골격은 안 건드림). 비어 있으면
  // 조용히 안 보인다 — "몰랐다"(완전 분리)도 "경계 흐림"(섞음)도 아닌 세 번째 선택.
  const outsideProjectSection = outsideProjectConvs.length > 0 && (
    <div className="mt-4 border-t border-border pt-4">
      <p className="mb-1 px-3 text-[11px] font-medium text-muted-foreground">
        {t('otherProjectsSection')}
      </p>
      {outsideProjectConvs.map((conv) => (
        <OutsideProjectRow key={conv.id} conv={conv} currentMemberId={currentTeamMemberId} onClick={() => handleOutsideProjectClick(conv)} />
      ))}
    </div>
  );

  const myConversationList = (
    <>
      {myListContent}
      {outsideProjectSection}
    </>
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
        <Button
          type="button"
          variant="ghost"
          onClick={() => void fetchAllConversations(agentOffset, true)}
          className="h-auto w-full rounded-lg py-2 text-xs font-normal text-muted-foreground transition hover:text-foreground"
        >
          더 보기 ({agentTotal - allConversations.length}건)
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* story #3177(S3a)+#3178(S3b) — chat 구심점 최상단 고정 「지금」 스트립+pulse 카드
          (대화 스크롤과 분리, 훑기 밀도 보존). Tabs 밖에 둔다 — my/agent 탭 전환과 무관하게
          항상 상단 고정. AC2 합산 불변식(#3178) — expandedSurface 하나로 둘 중 최대 1개만
          펼쳐지게 끌어올린다(하나를 펼치면 다른 하나는 자동 접힘). */}
      <div className="space-y-2 px-2 pt-2">
        <NowStrip
          expanded={expandedSurface === 'strip'}
          onExpandedChange={(v) => setExpandedSurface(v ? 'strip' : null)}
        />
        <PulseCard
          expanded={expandedSurface === 'pulse'}
          onExpandedChange={(v) => setExpandedSurface(v ? 'pulse' : null)}
        />
      </div>
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
