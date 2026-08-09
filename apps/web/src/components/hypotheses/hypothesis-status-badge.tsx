import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { HypothesisStatus } from '@sprintable/core-storage';

/**
 * 7-state hypothesis status badge (E1-S8 §3 — core deliverable).
 *
 * Soul lock (PO §12.1): verdict pair is verified=success(녹) / falsified=info(청).
 * `falsified` MUST NOT be destructive(red) — 반증에 빨강을 쓰면 사람이 라벨링을 회피해
 * 루프가 죽는다(백서). AC8: 색만으로 구분하지 않도록 상태 라벨 텍스트를 항상 동반한다.
 *
 * 색 규율 완성(유나 design, 2026-08-09, #2930 재QA) — verified=success(녹·✓) ·
 * falsified=info(청·✕, 반증=학습 신호) · killed=destructive(빨강·⊘) — ⭐빨강(destructive)의
 * 유일한 자리는 killed(자기 kill, 판정 아닌 중단)뿐이다. 색 3갈래(성공/학습/중단)가 이걸로
 * 완성된다.
 */
const MARK: Record<HypothesisStatus, string> = {
  proposed: '✎',
  active: '•',
  measuring: '◷',
  verified: '✓',
  // story #2533 follow-up(유나 design 재검, 2026-08-09) — 색은 info(청) 유지하되(반증=학습
  // 신호) ✕ 글리프로 "닫힘 아니라 낳음"이 즉시 읽히게. killed는 ⊘(아래 색 규율 완성 참고)라
  // 글리프도 이제 겹치지 않는다.
  falsified: '✕',
  killed: '⊘',
  archived: '🗄',
};

export function HypothesisStatusBadge({
  status,
  className,
}: {
  status: HypothesisStatus;
  className?: string;
}) {
  const t = useTranslations('hypotheses');
  const labelKey = `status${status.charAt(0).toUpperCase()}${status.slice(1)}` as 'statusProposed';
  const label = t(labelKey);

  // 진행: proposed(점선 outline)·active(중립 + live dot)·measuring(warning).
  if (status === 'proposed') {
    return (
      <Badge variant="outline" className={cn('gap-1 border-dashed text-muted-foreground', className)}>
        <span aria-hidden>{MARK.proposed}</span>
        {label}
      </Badge>
    );
  }
  if (status === 'active') {
    return (
      <Badge variant="secondary" className={cn('gap-1.5', className)}>
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        {label}
      </Badge>
    );
  }
  if (status === 'measuring') {
    return (
      <Badge variant="warning" className={cn('gap-1', className)}>
        <span aria-hidden>{MARK.measuring}</span>
        {label}
      </Badge>
    );
  }
  // 판정: verified=success(녹)·falsified=info(청) — filled 강조·동등 위계.
  if (status === 'verified') {
    return (
      <Badge variant="success" className={cn('gap-1 font-semibold', className)}>
        <span aria-hidden>{MARK.verified}</span>
        {label}
      </Badge>
    );
  }
  if (status === 'falsified') {
    return (
      <Badge variant="info" className={cn('gap-1 font-semibold', className)}>
        <span aria-hidden>{MARK.falsified}</span>
        {label}
      </Badge>
    );
  }
  // 종료: killed=destructive(빨강, ⭐그 유일한 자리)·archived(chip + 최저 opacity).
  if (status === 'killed') {
    return (
      <Badge variant="destructive" className={cn('gap-1 font-semibold', className)}>
        <span aria-hidden>{MARK.killed}</span>
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="chip" className={cn('gap-1 opacity-60', className)}>
      <span aria-hidden>{MARK.archived}</span>
      {label}
    </Badge>
  );
}
