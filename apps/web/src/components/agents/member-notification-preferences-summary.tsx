'use client';

import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DeliveryContractModal } from '@/components/chat/delivery-contract-modal';
import { fetchWithAuth } from '@/lib/db/client';

interface PreferenceItem {
  scope_type: string;
  scope_id: string | null;
  channel: string;
  level: 'all' | 'mentions' | 'mute';
}

interface ConversationLabel {
  type: 'dm' | 'group';
  title: string | null;
}

const LEVEL_LABEL_KEYS: Record<PreferenceItem['level'], string> = {
  all: 'deliveryContractLevel_all',
  mentions: 'deliveryContractLevel_mentions',
  mute: 'deliveryContractLevel_mute',
};

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: PreferenceItem[] };

/**
 * story #2623 — 「이 멤버는 어느 대화에서 무엇을 받나」 읽기 표면(멤버 관점 요약, AC3) +
 * 유나 design 확定(08-14, #2623 협의 스레드) — 각 행 trailing에 per-row 「편집」 트리거.
 * 신규 API 없음 — 기존 `GET /api/notification-preferences?member_id=`(story 933248fa 동형
 * admin override, BE 착지 대기 — 그라운딩 완료·PO 08-14 승인)와 `GET /api/conversations/{id}`
 * (제목 해소, 대화 페이지가 이미 쓰는 그 엔드포인트 재사용)만 쓴다.
 *
 * ⚠️ BE 착지 前엔 `member_id` 쿼리를 서버가 아직 안 읽어(self-only 하드고정) 호출자
 * 자신의 목록이 돌아오거나 403이 날 수 있다 — 이 컴포넌트는 그 두 경우 다 정직하게
 * 렌더한다(빈 목록을 "받는 게 없다"로 지어내지 않는다, error 상태로 갈린다).
 *
 * 편집 트리거(Pencil)는 DeliveryContractModal을 (targetMemberId=memberId, conversationId=
 * 그 행의 scope_id)로 연다 — 별도 조회 없이 행이 이미 가진 값으로 연다(유나 확定 ①).
 * 권한은 이 컴포넌트 자체가 admin/owner 게이트 뒤에서만 렌더되므로(workforce/[id]/page.tsx
 * canEditWebhook 상속) 트리거에서 따로 재검사하지 않는다 — 실 enforcement는 BE(933248fa
 * 선례, fail-closed).
 */
export function MemberNotificationPreferencesSummary({ memberId, memberLabel }: { memberId: string; memberLabel: string }) {
  const t = useTranslations('chats');
  const ts = useTranslations('settings');
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [labelsById, setLabelsById] = useState<Record<string, ConversationLabel>>({});
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/notification-preferences?member_id=${encodeURIComponent(memberId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json: { data?: { data?: PreferenceItem[] } | PreferenceItem[] }) => {
        if (cancelled) return;
        const list = Array.isArray(json.data) ? json.data : (json.data as { data?: PreferenceItem[] } | undefined)?.data ?? [];
        const conversationLevels = list.filter((p) => p.scope_type === 'conversation' && p.channel === 'sse');
        setState({ kind: 'ready', items: conversationLevels });
      })
      .catch(() => { if (!cancelled) setState({ kind: 'error' }); });
    return () => { cancelled = true; };
  }, [memberId]);

  // 유나 확定 ④ — raw conversationId 노출은 admin이 "어느 대화"인지 못 앎. 대화 페이지와
  // 동일 `GET /api/conversations/{id}`를 행마다 병렬 조회(N개, admin 1인의 에이전트 관리
  // 화면이라 통상 소수 — 배치 엔드포인트가 아직 없어 우선 이 모양으로, 커지면 후속).
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const ids = [...new Set(state.items.map((p) => p.scope_id).filter((id): id is string => !!id))];
    const missing = ids.filter((id) => !(id in labelsById));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(async (id) => {
      try {
        const res = await fetchWithAuth(`/api/conversations/${id}`);
        if (!res.ok) return [id, null] as const;
        const conv = await res.json() as { title?: string | null; type?: 'dm' | 'group' };
        return [id, { title: conv.title ?? null, type: conv.type ?? 'group' }] as const;
      } catch {
        return [id, null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setLabelsById((prev) => {
        const next = { ...prev };
        for (const [id, label] of entries) if (label) next[id] = label;
        return next;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsById는 "이미 아는 id 재조회 방지" 가드로만 읽는다(effect 재실행 트리거로 넣으면 매 응답마다 무한 루프).
  }, [state]);

  if (state.kind === 'loading') {
    return <div className="h-16 animate-pulse rounded-lg bg-muted" />;
  }
  if (state.kind === 'error') {
    return <p className="text-xs text-muted-foreground">{ts('notificationPreferencesSummaryLoadError')}</p>;
  }
  if (state.items.length === 0) {
    return <p className="text-xs text-muted-foreground">{ts('notificationPreferencesSummaryEmpty')}</p>;
  }
  return (
    <>
      <ul className="space-y-1.5">
        {state.items.map((p, i) => {
          const label = p.scope_id ? labelsById[p.scope_id] : undefined;
          const displayName = label?.title ?? (p.scope_id ? `#${p.scope_id.slice(0, 8)}` : '?');
          return (
            <li key={i} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
              <span className="min-w-0 truncate text-foreground" title={p.scope_id ?? undefined}>{displayName}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-medium text-foreground">{t(LEVEL_LABEL_KEYS[p.level])}</span>
                {p.scope_id && (
                  <button
                    type="button"
                    onClick={() => setEditingConversationId(p.scope_id)}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={ts('notificationPreferencesSummaryEdit')}
                    title={ts('notificationPreferencesSummaryEdit')}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {editingConversationId && (
        <DeliveryContractModal
          conversationId={editingConversationId}
          conversationType={labelsById[editingConversationId]?.type ?? 'group'}
          freeResponse={false}
          targetMemberId={memberId}
          targetMemberLabel={memberLabel}
          onClose={() => setEditingConversationId(null)}
          onFreeResponseChange={() => {}}
        />
      )}
    </>
  );
}
