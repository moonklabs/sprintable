'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkListRow, WorkListRowState } from './derive-work-list';

// 시안 3840 v2(artifact 06d2d61c) — 위임+진행 중/완료 행만 채운 점(●) 표식(진행 중=파랑,
// 완료=초록). 승인/서명/답 대기나 미위임 행은 표식 없음(있을 때만, 지어내지 않음).
// ⭐라이브 렌더 실사고(2026-09-14) — 처음엔 isDelegated를 안 받고 state만 봐서 미위임
// «진행 중»/«완료» 행에도 점이 찍혔다(유닛테스트가 isDelegated=true 케이스만 돌려 못 잡음,
// 스크린샷 대조로 발견). isDelegated를 두 번째 파라미터로 받아 AND 조건으로 좁힌다.
function DelegatedDot({ isDelegated, state }: { isDelegated: boolean; state: WorkListRowState }) {
  if (!isDelegated || (state !== 'in_progress' && state !== 'done')) return null;
  return <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', state === 'done' ? 'bg-success' : 'bg-primary')} aria-hidden="true" />;
}

// today-sections.tsx STATE_META와 동형 매핑 — pending 3상태는 badge variant="info" 통일(색은
// 위임/완료 dot이, pending 3어는 라벨 자체가 구분한다).
const STATE_BADGE: Partial<Record<NonNullable<WorkListRowState>, { key: string; variant: 'info' | 'secondary' | 'success' }>> = {
  awaiting_approval: { key: 'stateAwaitingApproval', variant: 'info' },
  awaiting_signature: { key: 'stateAwaitingSignature', variant: 'info' },
  awaiting_answer: { key: 'stateAwaitingAnswer', variant: 'info' },
  in_progress: { key: 'stateInProgress', variant: 'secondary' },
  done: { key: 'stateDone', variant: 'success' },
};

export function WorkListRowView({ row }: { row: WorkListRow }) {
  const t = useTranslations('workList');
  const badge = row.state ? STATE_BADGE[row.state] : undefined;

  return (
    <div className="flex items-start gap-2 border-t border-border px-3 py-2.5 first:border-t-0">
      <DelegatedDot isDelegated={row.isDelegated} state={row.state} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{row.title}</span>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {row.hasArtifacts ? <Badge variant="chip">{t('chipHasArtifacts')}</Badge> : null}
        {row.lowRisk ? <Badge variant="chip">{t('chipLowRisk')}</Badge> : null}
        {row.isDelegated ? <Badge variant="chip">{row.ownerName ? `${t('chipDelegated')} · ${row.ownerName}` : t('chipDelegated')}</Badge> : null}
        {badge ? <Badge variant={badge.variant}>{t(badge.key)}</Badge> : null}
      </div>
    </div>
  );
}
