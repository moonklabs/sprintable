import { useTranslations } from 'next-intl';
import { Chip } from '@/components/ds/chip';
import { cn } from '@/lib/utils';
import type { HypothesisStatus } from '@sprintable/core-storage';

/**
 * 7-state hypothesis status chip (E1-S8 §3 — core deliverable) — 4909 AC3 (가설 칸 2단계): the ds `Chip` (state word + mark; the colour only where it MEANS something).
 *
 * Soul lock (PO §12.1): verdict pair is verified=done(녹) / falsified=info(청). `falsified` MUST NOT be failed(red) — 반증에 빨강을 쓰면 사람이 라벨링을 회피해 루프가 죽는다(백서).
 * AC8: 색만으로 구분하지 않도록 상태 라벨 텍스트를 항상 동반한다. 색 3갈래(성공/학습/중단) — ⭐빨강(failed)의 유일한 자리는 killed(자기 kill, 판정 아닌 중단)뿐이다. measuring = 호박(예전 warning 자리 그대로).
 * 기호: proposed ✎ (점선 윤곽) · active = 점(글자 앞 점) · measuring ◷ · verified ✓ · falsified ✕ · killed ⊘ · archived 🗄 (가장 흐림).
 */
const MARK: Record<HypothesisStatus, string> = {
  proposed: '✎',
  active: '•',
  measuring: '◷',
  verified: '✓',
  // story #2533 follow-up(유나 design 재검, 2026-08-09) — 색은 info(청) 유지하되(반증=학습 신호) ✕ 글리프로 "닫힘 아니라 낳음"이 즉시 읽히게. killed는 ⊘라 글리프도 겹치지 않는다.
  falsified: '✕',
  killed: '⊘',
  archived: '🗄',
};

/** status → the chip's tone (exported so the tests and the row can read the one table) */
export const STATUS_TONE = {
  proposed: 'neutral',
  active: 'neutral',
  measuring: 'needs-hand',
  verified: 'done',
  falsified: 'info',
  killed: 'failed',
  archived: 'neutral',
} as const satisfies Record<HypothesisStatus, 'neutral' | 'needs-hand' | 'done' | 'info' | 'failed'>;

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
  const judged = status === 'verified' || status === 'falsified' || status === 'killed';
  const common = { tone: STATUS_TONE[status], 'data-status': status, className: cn(status === 'proposed' && 'border-dashed', judged && 'font-semibold', status === 'archived' && 'opacity-60', className) } as const;

  // 진행 중(active)은 점 + 글자, 나머지는 기호 + 글자(색만으로 뜻을 싣지 않는다).
  if (status === 'active') return <Chip {...common} dot>{label}</Chip>;
  return (
    <Chip {...common}>
      <span aria-hidden>{MARK[status]}</span>
      {label}
    </Chip>
  );
}
