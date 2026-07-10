import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { MemberRef } from '@/services/canvas';
import type { CommentRecipient, PropagationState } from '@/services/canvas-comments';

const STATE_ORDER: PropagationState[] = ['pending', 'delivered', 'read', 'acting', 'responded'];
const STATE_LABEL_KEY: Record<PropagationState, string> = {
  pending: '', // pending은 단독일 때 "{name}에게 전달 중…" 문장 자체로 표현(별도 라벨 없음)
  delivered: 'stateDelivered',
  read: 'stateRead',
  acting: 'stateActing',
  responded: 'stateResponded',
};

function isEngaged(state: PropagationState): boolean {
  return state === 'acting' || state === 'responded';
}

function stateRank(state: PropagationState): number {
  return STATE_ORDER.indexOf(state);
}

function initials(name: string): string {
  return name.slice(0, 1);
}

interface PropagationStripProps {
  recipients: CommentRecipient[];
  memberMap?: Record<string, MemberRef>;
  linkedVersion?: number | null;
  onLinkedVersionClick?: (version: number) => void;
  className?: string;
}

/**
 * E-CANVAS C2 §3-6 전파 strip — "코멘트가 도달·응답됐는가"를 표면화. **감시-게이트(§3-7)**:
 * 응답 시간 점수·리더보드·"방치" 낙인 전부 없음 — pending도 calm muted(빨강/경고색 0).
 * 가장 진행된 상태의 수신자 하나만 강조 표시 + 나머지는 "+N 도달"로 aggregate(과부하 방지).
 */
export function PropagationStrip({ recipients, memberMap = {}, linkedVersion, onLinkedVersionClick, className }: PropagationStripProps) {
  const t = useTranslations('canvas');
  if (recipients.length === 0) return null;

  const sorted = [...recipients].sort((a, b) => stateRank(b.state) - stateRank(a.state));
  const primary = sorted[0]!;
  const restCount = sorted.length - 1;
  const primaryName = memberMap[primary.member_id]?.name ?? '—';
  const engaged = isEngaged(primary.state);

  return (
    <div className={cn('rounded-lg px-2.5 py-1.5 text-[11px]', engaged ? 'bg-info/10' : 'bg-muted/40', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[8px] font-bold text-primary">
          {initials(primaryName)}
        </span>
        <span className={cn(engaged ? 'font-semibold text-info' : 'text-muted-foreground')}>
          {primary.state === 'pending' && restCount === 0
            ? t('deliveringTo', { name: primaryName })
            : `${primaryName} ${t(STATE_LABEL_KEY[primary.state])}`}
        </span>
        {restCount > 0 ? <span className="text-muted-foreground">· {t('moreReached', { count: restCount })}</span> : null}
      </div>
      {linkedVersion != null ? (
        <p className="mt-1 text-muted-foreground">
          {'↳ '}
          {onLinkedVersionClick ? (
            <button type="button" onClick={() => onLinkedVersionClick(linkedVersion)} className="font-semibold text-info hover:underline">
              {t('linkedVersionResult', { version: linkedVersion })}
            </button>
          ) : (
            <span className="font-semibold text-info">{t('linkedVersionResult', { version: linkedVersion })}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}
