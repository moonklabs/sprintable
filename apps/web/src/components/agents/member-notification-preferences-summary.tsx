'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

interface PreferenceItem {
  scope_type: string;
  scope_id: string | null;
  channel: string;
  level: 'all' | 'mentions' | 'mute';
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
 * story #2623 — 「이 멤버는 어느 대화에서 무엇을 받나」 읽기 표면(멤버 관점 요약, AC3).
 * 신규 API 없음 — 기존 `GET /api/notification-preferences?member_id=`(story 933248fa
 * 동형 admin override, BE 착지 대기 — 그라운딩 완료·PO 08-14 승인)를 그대로 재사용한다.
 * scope_type='conversation'·channel='sse' 항목만 보여준다(DeliveryContractModal이 편집
 * 하는 그 축과 동일 — #2621 v1 범위와 어긋나지 않게, discord/telegram/in_app은 별개
 * 표면인 notification-settings의 몫).
 *
 * ⚠️ BE 착지 前엔 `member_id` 쿼리를 서버가 아직 안 읽어(self-only 하드고정) 호출자
 * 자신의 목록이 돌아오거나 403이 날 수 있다 — 이 컴포넌트는 그 두 경우 다 정직하게
 * 렌더한다(빈 목록을 "받는 게 없다"로 지어내지 않는다, error 상태로 갈린다).
 *
 * 대화 제목은 이 응답에 없다(scope_id=conversationId만) — v1은 conversation id로 보여주고
 * 클릭 시 그 대화로 이동(제목 해소는 유나 design 리뷰에서 필요하다고 판단되면 후속).
 */
export function MemberNotificationPreferencesSummary({ memberId }: { memberId: string }) {
  const t = useTranslations('chats');
  const ts = useTranslations('settings');
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/notification-preferences?member_id=${encodeURIComponent(memberId)}`)
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
    <ul className="space-y-1.5">
      {state.items.map((p, i) => (
        <li key={i} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
          <span className="min-w-0 truncate font-mono text-muted-foreground">{p.scope_id}</span>
          <span className="shrink-0 font-medium text-foreground">{t(LEVEL_LABEL_KEYS[p.level])}</span>
        </li>
      ))}
    </ul>
  );
}
