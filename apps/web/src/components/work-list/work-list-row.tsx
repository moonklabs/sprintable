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

// PO 지적(2026-09-14, 시안 06d2d61c 재대조) — 상태 낱말은 pill/Badge가 아니라 «색 글자».
// 승인·서명·답 대기=text-warning-strong(§2594 선례 — 평문 text-warning은 흰 배경 AA
// 미달이라 -strong 변형이 텍스트 전용 안전값)·진행 중=muted(차분)·완료=success. 07:30Z에
// 지시했던 "Badge variant=warning"은 이 처방으로 대체(PO 본인 정정).
// story #3845(우패널, 2026-09-14) — export: 우패널의 「지금 상태」 줄이 이 맵을 그대로
// 재사용한다(SSOT 1곳 — 낱말/색을 두 번째로 손으로 다시 치지 않는다).
export const STATE_TEXT: Partial<Record<NonNullable<WorkListRowState>, { key: string; className: string }>> = {
  awaiting_approval: { key: 'stateAwaitingApproval', className: 'text-warning-strong' },
  awaiting_signature: { key: 'stateAwaitingSignature', className: 'text-warning-strong' },
  awaiting_answer: { key: 'stateAwaitingAnswer', className: 'text-warning-strong' },
  in_progress: { key: 'stateInProgress', className: 'text-muted-foreground' },
  done: { key: 'stateDone', className: 'text-success' },
};

export function WorkListRowView({
  row, isSelected = false, onSelect,
}: {
  row: WorkListRow;
  /** story #3845 — 우패널 행 선택 하이라이트(있을 때만, 기본 false — 기존 소비처(테스트
   * 등)는 onSelect/isSelected 없이도 무변 렌더). */
  isSelected?: boolean;
  onSelect?: (rowId: string) => void;
}) {
  const t = useTranslations('workList');
  const stateText = row.state ? STATE_TEXT[row.state] : undefined;

  return (
    <div
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? isSelected : undefined}
      onClick={onSelect ? () => onSelect(row.id) : undefined}
      onKeyDown={onSelect ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(row.id); }
      } : undefined}
      className={cn(
        'flex items-start gap-2 border-t border-border px-3 py-2.5 first:border-t-0',
        onSelect && 'cursor-pointer hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // story #3845 — 선택 하이라이트(work-list-shell.tsx의 스토리 구간 accent border와
        // 같은 primary 계열 재사용 — 새 토큰 0).
        isSelected && 'bg-muted',
      )}
    >
      <DelegatedDot isDelegated={row.isDelegated} state={row.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] text-foreground">{row.title}</div>
        {/* 행 부제=담당 이름(있을 때만·PO 지적 — 위임/배정 둘 다). 검토 축은 실 데이터가
            없어 생략(지어내지 않음, 시안의 "작성·검토" 서술문은 이 카드 데이터로 못 채움). */}
        {row.ownerName ? <div className="truncate text-xs text-muted-foreground">{row.ownerName}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {row.artifactCount > 0 ? <Badge variant="chip">{t('chipArtifacts', { count: row.artifactCount })}</Badge> : null}
        {row.lowRisk ? <Badge variant="chip">{t('chipLowRisk')}</Badge> : null}
        {row.isDelegated ? (
          <Badge variant="chip">{t('chipDelegated')}</Badge>
        ) : row.ownerName ? (
          <Badge variant="chip">{t('chipAssigned')}</Badge>
        ) : null}
        {stateText ? <span className={cn('text-xs font-medium', stateText.className)}>{t(stateText.key)}</span> : null}
      </div>
    </div>
  );
}
