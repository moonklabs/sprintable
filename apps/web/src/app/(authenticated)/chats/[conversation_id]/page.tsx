'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bell, BellOff, ChevronLeft, UserPlus, Pencil, Settings } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatView } from '@/components/chat/chat-view';
import type { PresenceStatus } from '@/components/chat/presence-dot';
import { AddParticipantModal } from '@/components/chat/add-participant-modal';
import { DeliveryContractModal } from '@/components/chat/delivery-contract-modal';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar } from '@/components/shared/avatar';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';

import { fetchWithAuth } from '@/lib/db/client';

interface Participant {
  member_id: string;
  name: string | null;
  avatar_url?: string | null;
  type?: string;
  // S8b: list participants 직렬화에 runtime_type 노출(미머지 시 필드 부재=undefined → #2 경고 미표시 graceful).
  runtime_type?: string | null;
}

interface ConversationMeta {
  title: string | null;
  type: 'dm' | 'group';
  participants: Participant[];
  // per-대화 알림 mute (270c87e6). conversation list/detail 응답의 caller `muted`
  // (#1427에서 노출)로 벨 초기 상태를 그린다. 부재 시 false로 graceful(하위호환).
  muted: boolean;
  // story #1977(트랙B): #1976 read state 계약 — caller last_read_at. ChatView의 "여기부터
  // 안읽음" 마커 경계로 소비(진입 시점 값만 필요, 마커는 이 화면 방문 내내 동결).
  lastReadAt: string | null;
  // story #2621 v1 — 전달 계약 편집 모달의 free_response 초기값(conversation.free_response,
  // EF-S2/#2603 P0). 부재 시 false로 graceful(하위호환 — 옛 응답엔 이 필드가 없을 수 있음).
  freeResponse: boolean;
}

// story #2168 PR-②(오르테가 지적) — `?from=`은 사용자가 URL을 통해 조작 가능한 값이다.
// 형식이 project id(UUID)가 아니면 그대로 뒤로가기 URL에 실어 보내지 않는다(임의 값이
// URL을 타고 계속 돌지 않게) — docs.ts의 기존 UUID 판별 정규식과 동형.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidProjectId(value: string | null): value is string {
  return !!value && UUID_RE.test(value);
}

function formatHeaderTitle(meta: ConversationMeta, currentMemberId: string): string {
  if (meta.title) return meta.title;
  const others = meta.participants.filter((p) => p.member_id !== currentMemberId);
  if (others.length === 0) return meta.type === 'dm' ? 'DM' : '그룹 채팅';
  if (meta.type === 'dm') return others[0]?.name ?? '?';
  const MAX = 3;
  if (others.length <= MAX) return others.map((p) => p.name ?? '?').join(', ');
  return `${others.slice(0, MAX).map((p) => p.name ?? '?').join(', ')} 외 ${others.length - MAX}명`;
}

export default function ConversationPage() {
  const { conversation_id } = useParams<{ conversation_id: string }>();
  const router = useRouter();
  // story #1959(P2-S3): 딥링크 매니페스트(chat_thread→parentTab=chat) — 콜드 진입 시 "채팅"
  // 탭 루트를 BACK 대상으로 선주입. 목록에서 클릭해 온 경우(history.length>1)는 no-op.
  useSyntheticParentTabHistory('/chats');
  // Deeplink (ade2d6d5): /chats/{id}?messageId={uuid} → ChatView scrolls to + highlights it.
  // ChatView has key={conversation_id} so this is read fresh per conversation.
  const searchParams = useSearchParams();
  const scrollToMessageId = searchParams.get('messageId') ?? undefined;
  const t = useTranslations('chats');
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const [meta, setMeta] = useState<ConversationMeta | null>(null);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [showDeliveryContract, setShowDeliveryContract] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // story #2168 PR-② — chat-list-view.tsx의 "다른 프로젝트" 항목 클릭이 실어 보내는 복귀 정보.
  // `from` = 원래 있던 프로젝트(뒤로가기 시 복귀 대상) · `pn` = 이 대화가 속한 프로젝트명(권한
  // 회수 등으로 조회 자체가 403이면 그 응답에서 이름을 못 얻으므로 클릭 시점 값을 폴백으로 씀).
  const fromProjectIdRaw = searchParams.get('from');
  const fromProjectId = isValidProjectId(fromProjectIdRaw) ? fromProjectIdRaw : null;
  const conversationProjectName = searchParams.get('pn');
  // ⛔실패 자리(스펙 확定) — 능동으로 눌러 들어왔는데(다른 프로젝트 섹션 경유) 그 사이 권한이
  // 회수돼 403이면, 조용히 빠지는 게 아니라 그때만 안내한다(중립 톤·다음 발 포함·빨강 금지).
  const [blocked, setBlocked] = useState(false);

  // story #2009: 목록 통호출(`/api/conversations?project_id=`, default limit 30)+client
  // `.find()` 우회를 폐기 — 대화 1건 메타 보려고 매번 최대30건치 쿼리(latest_message N+1
  // 포함)를 낭비했고, org 대화가 30건 넘으면 최근 30건 밖 대화를 열 때 `.find()`가 undefined를
  // 반환해 헤더가 영구 공백이었다(정합성 버그, BE #2286이 단독조회에 participants 추가해 해소).
  const fetchMeta = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetchWithAuth(`/api/conversations/${conversation_id}`);
      if (res.status === 403) { setBlocked(true); return; }
      if (!res.ok) return;
      const conv = await res.json() as {
        title: string | null; type: 'dm' | 'group'; participants?: Participant[]; muted?: boolean; last_read_at?: string | null;
        free_response?: boolean;
      };
      setMeta({
        title: conv.title,
        type: conv.type,
        participants: conv.participants ?? [],
        muted: conv.muted ?? false,
        lastReadAt: conv.last_read_at ?? null,
        freeResponse: conv.free_response ?? false,
      });
    } catch { /* non-critical */ }
  }, [conversation_id, projectId]);

  // per-대화 알림 mute 토글 (270c87e6 AC③⑤). 낙관 갱신 → PATCH /mute → 실패 시 롤백.
  // mute는 알림 생성/노출만 억제(참여자 지위·메시지 수신 불변, BE).
  const handleToggleMute = useCallback(async () => {
    if (!meta) return;
    const next = !meta.muted;
    setMeta((m) => (m ? { ...m, muted: next } : m));
    try {
      const res = await fetchWithAuth(`/api/conversations/${conversation_id}/mute`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted: next }),
      });
      if (!res.ok) setMeta((m) => (m ? { ...m, muted: !next } : m));
    } catch {
      setMeta((m) => (m ? { ...m, muted: !next } : m));
    }
  }, [meta, conversation_id]);

  // EF-S2: rename a group room. Optimistic; the BE PATCH persists the title.
  const handleSaveTitle = useCallback(async () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === (meta?.title ?? '')) return;
    setMeta((m) => (m ? { ...m, title: next } : m));
    try {
      await fetchWithAuth(`/api/conversations/${conversation_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
    } catch { /* optimistic; a later refetch reconciles */ }
  }, [titleDraft, meta, conversation_id]);

  // 1aeecdde P2: 에이전트 presence_status(연결축 dot) 폴링 — P1 진실값. 15s 갱신(시간 기반 상태).
  const [presenceById, setPresenceById] = useState<Record<string, PresenceStatus>>({});
  const fetchPresence = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/team-members?type=agent');
      if (!res.ok) return;
      const json = await res.json() as { data?: Array<{ id: string; presence_status?: string | null }> };
      const map: Record<string, PresenceStatus> = {};
      for (const m of json.data ?? []) {
        if (m.presence_status === 'online' || m.presence_status === 'idle' || m.presence_status === 'offline') {
          map[m.id] = m.presence_status;
        }
      }
      setPresenceById(map);
    } catch { /* non-critical */ }
  }, []);

  // 마운트 1회 fetch(단일행·기존 fetchMeta 패턴 동형) + 15s 폴링(시간 기반 presence 갱신).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchPresence(); }, [fetchPresence]);
  useEffect(() => {
    const interval = setInterval(() => { void fetchPresence(); }, 15000);
    return () => clearInterval(interval);
  }, [fetchPresence]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchMeta(); }, [fetchMeta]);

  const handleParticipantAdded = useCallback((newConversationId?: string) => {
    setShowAddParticipant(false);
    if (newConversationId && newConversationId !== conversation_id) {
      // DM → group fork: navigate to new group chat
      router.push(`/chats/${newConversationId}`);
    } else {
      void fetchMeta();
    }
  }, [conversation_id, fetchMeta, router]);

  if (!currentTeamMemberId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">로딩 중…</p>
      </div>
    );
  }

  const headerTitle = meta
    ? formatHeaderTitle(meta, currentTeamMemberId)
    : (meta === null ? '채팅' : '로딩 중…');

  // story #2968 — 리스트(chat-list-view.tsx)와 동일 원칙: 1:1(DM)만 상대가 특정되므로
  // avatar.tsx 정본으로 실사진을 보여준다. group은 다인원이라 대표 사진이 없어 미표시 유지.
  const headerAvatarParticipant = meta?.type === 'dm'
    ? meta.participants.find((p) => p.member_id !== currentTeamMemberId)
    : null;

  // S8 #2: pre-send capability 경고 대상 = 에이전트 participant(본인 제외)·runtime_type 필드 존재시만.
  // (S8b 미머지 → runtime_type undefined → commandTargets 빈 배열 → 경고 미표시 graceful.)
  const commandTargets = (meta?.participants ?? [])
    .filter((p) => p.type === 'agent' && p.member_id !== currentTeamMemberId && p.runtime_type !== undefined)
    .map((p) => ({ agentId: p.member_id, agentName: p.name ?? '?', runtimeType: p.runtime_type ?? null }));

  return (
    <>
      <TopBarSlot
        title={
          // story #2988(선생님 실사용 지적) — top-bar.tsx의 `[&>*]:min-w-0 [&>*]:truncate`가
          // 이 title 루트 div 자신에 `overflow:hidden`을 건다(빌드 CSS 실측:
          // `.truncate{overflow:hidden;...}`). 텍스트 말줄임(6df91dce)이 원 의도였는데, 이
          // div의 자연 높이는 가장 큰 자식(Avatar 24px)에 맞춰지고, agent Avatar의
          // `ring-2 ring-offset-1`은 box-shadow라 레이아웃 박스 밖으로 3px 번진다(빌드 CSS
          // 실측: `calc(2px + 1px)` 링 반경) — overflow:hidden이 그 3px를 상하로 그대로
          // 잘라 "위아래가 잘려 렌더"됐다. py-1(4px)로 클립 경계를 링 밖까지 밀어낸다(회귀
          // 0 — 텍스트 말줄임 동작은 overflow:hidden이 여전히 걸려있어 그대로 유지).
          <div className="flex min-w-0 items-center gap-1 py-1">
            <button
              type="button"
              // story #1990: replace(), not push() — 콜드-진입 합성 스택에 세번째 엔트리를
              // 쌓지 않아 브라우저 BACK 재진입 트랩을 구조적으로 없앤다(§3.2). back()류 직접
              // 호출은 하지 않는다([[feedback-history-back-nextjs]]).
              // story #2168 PR-② AC④ — "다른 프로젝트" 경유로 왔으면(`from` 존재) 원래
              // 프로젝트로 `?p=`를 실어 복귀시킨다(R2 SSOT가 그대로 헤더·스위처를 되돌린다 —
              // "전환이 일방통행이 아니다"). 새 되돌리기 UI를 만들지 않고 기존 뒤로가기 버튼이
              // 그 역할을 겸한다.
              onClick={() => router.replace(fromProjectId ? `/chats?p=${fromProjectId}` : '/chats')}
              className="flex flex-shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="lg:hidden">채팅</span>
            </button>
            {headerAvatarParticipant && (
              <Avatar
                name={headerAvatarParticipant.name ?? '?'}
                avatarUrl={headerAvatarParticipant.avatar_url ?? null}
                actorType={headerAvatarParticipant.type === 'agent' ? 'agent' : 'human'}
                size={24}
                className="flex-shrink-0"
              />
            )}
            {editingTitle && meta?.type === 'group' ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveTitle();
                  else if (e.key === 'Escape') setEditingTitle(false);
                }}
                onBlur={() => void handleSaveTitle()}
                aria-label="방 이름 편집"
                className="min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            ) : meta?.type === 'group' ? (
              <button
                type="button"
                onClick={() => { setTitleDraft(meta.title ?? ''); setEditingTitle(true); }}
                className="group/title flex min-w-0 items-center gap-1"
                aria-label="방 이름 편집"
              >
                {/* story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — 헤더 상대명/
                    방이름=Claim(600)로 재분류(리스트 대화명과 동일 처방, 구조·크기 불변). */}
                <span className="min-w-0 truncate text-sm font-semibold text-foreground">{headerTitle}</span>
                <Pencil className="size-3 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100" aria-hidden />
              </button>
            ) : (
              <span className="min-w-0 truncate text-sm font-semibold text-foreground">{headerTitle}</span>
            )}
          </div>
        }
        actions={
          meta && (
            <div className="flex items-center gap-1">
              {/* per-대화 알림 mute 토글 (270c87e6). mute=BellOff + "알림 꺼짐" 시각 표시. */}
              <button
                type="button"
                onClick={() => void handleToggleMute()}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                title={meta.muted ? '알림 켜기' : '알림 끄기'}
                aria-label={meta.muted ? '알림 켜기' : '알림 끄기'}
                aria-pressed={meta.muted}
              >
                {meta.muted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                {meta.muted ? <span className="hidden sm:inline">알림 꺼짐</span> : null}
              </button>
              <button
                type="button"
                onClick={() => setShowAddParticipant(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                title="참여자 추가"
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">참여자 추가</span>
              </button>
              {/* story #2621 v1 — 전달 계약 편집 진입점(대화 설정). */}
              <button
                type="button"
                onClick={() => setShowDeliveryContract(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                title={t('deliveryContractTitle')}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {blocked ? (
          // story #2168 PR-② — 능동 클릭 후 접근 불가(권한 회수 등, BE 403 — 인가는 이미
          // 쿼리 자체가 막는다·여기선 신규 인가 로직 0). ⛔중립 톤(destructive/빨강 금지) —
          // 사용자가 실패한 게 아니라 접근 범위 밖인 상태(#2198 403 문구와 같은 규율).
          // 관리자 "이름"은 이번 스코프 밖(그 자체로 새 인가 표면) — "요청하세요"까지만.
          <div className="flex h-full items-center justify-center p-4">
            <EmptyState
              title={t('conversationBlockedTitle')}
              description={`${t('conversationBlockedBody', { project: conversationProjectName ?? t('conversationBlockedProjectFallback') })} ${t('conversationBlockedNext', { project: conversationProjectName ?? t('conversationBlockedProjectFallback') })}`}
              className="w-full max-w-sm"
            />
          </div>
        ) : (
          <ChatView
            key={conversation_id}
            threadId={conversation_id}
            currentTeamMemberId={currentTeamMemberId}
            projectId={projectId}
            apiPrefix="/api/conversations"
            commandTargets={commandTargets}
            presenceById={presenceById}
            scrollToMessageId={scrollToMessageId}
            initialLastReadAt={meta ? meta.lastReadAt : undefined}
            participants={meta?.participants ?? []}
          />
        )}
      </div>

      {showAddParticipant && meta && projectId && (
        <AddParticipantModal
          conversationId={conversation_id}
          conversationType={meta.type}
          projectId={projectId}
          existingParticipantIds={meta.participants.map((p) => p.member_id)}
          onClose={() => setShowAddParticipant(false)}
          onAdded={handleParticipantAdded}
        />
      )}

      {showDeliveryContract && meta && (
        <DeliveryContractModal
          conversationId={conversation_id}
          conversationType={meta.type}
          freeResponse={meta.freeResponse}
          onClose={() => setShowDeliveryContract(false)}
          onFreeResponseChange={(next) => setMeta((m) => (m ? { ...m, freeResponse: next } : m))}
        />
      )}
    </>
  );
}
