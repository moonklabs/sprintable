'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Bell, BellOff, ChevronLeft, UserPlus, Pencil } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatView } from '@/components/chat/chat-view';
import type { PresenceStatus } from '@/components/chat/presence-dot';
import { AddParticipantModal } from '@/components/chat/add-participant-modal';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';

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
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const [meta, setMeta] = useState<ConversationMeta | null>(null);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const fetchMeta = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/conversations?project_id=${projectId}`);
      if (!res.ok) return;
      const json = await res.json() as {
        data: Array<{ id: string; title: string | null; type: 'dm' | 'group'; participants?: Participant[]; muted?: boolean }>;
      };
      const conv = json.data.find((c) => c.id === conversation_id);
      if (conv) setMeta({ title: conv.title, type: conv.type, participants: conv.participants ?? [], muted: conv.muted ?? false });
    } catch { /* non-critical */ }
  }, [conversation_id, projectId]);

  // per-대화 알림 mute 토글 (270c87e6 AC③⑤). 낙관 갱신 → PATCH /mute → 실패 시 롤백.
  // mute는 알림 생성/노출만 억제(참여자 지위·메시지 수신 불변, BE).
  const handleToggleMute = useCallback(async () => {
    if (!meta) return;
    const next = !meta.muted;
    setMeta((m) => (m ? { ...m, muted: next } : m));
    try {
      const res = await fetch(`/api/conversations/${conversation_id}/mute`, {
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
      await fetch(`/api/conversations/${conversation_id}`, {
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
      const res = await fetch('/api/team-members?type=agent');
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

  // S8 #2: pre-send capability 경고 대상 = 에이전트 participant(본인 제외)·runtime_type 필드 존재시만.
  // (S8b 미머지 → runtime_type undefined → commandTargets 빈 배열 → 경고 미표시 graceful.)
  const commandTargets = (meta?.participants ?? [])
    .filter((p) => p.type === 'agent' && p.member_id !== currentTeamMemberId && p.runtime_type !== undefined)
    .map((p) => ({ agentId: p.member_id, agentName: p.name ?? '?', runtimeType: p.runtime_type ?? null }));

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => router.push('/chats')}
              className="flex flex-shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="lg:hidden">채팅</span>
            </button>
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
                className="min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            ) : meta?.type === 'group' ? (
              <button
                type="button"
                onClick={() => { setTitleDraft(meta.title ?? ''); setEditingTitle(true); }}
                className="group/title flex min-w-0 items-center gap-1"
                aria-label="방 이름 편집"
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{headerTitle}</span>
                <Pencil className="size-3 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100" aria-hidden />
              </button>
            ) : (
              <span className="min-w-0 truncate text-sm font-medium text-foreground">{headerTitle}</span>
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
            </div>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <ChatView
          key={conversation_id}
          threadId={conversation_id}
          currentTeamMemberId={currentTeamMemberId}
          projectId={projectId}
          apiPrefix="/api/conversations"
          commandTargets={commandTargets}
          presenceById={presenceById}
        />
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
    </>
  );
}
