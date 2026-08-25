import { cn } from '@/lib/utils';

/**
 * story #3049(2984-S1, doc diff-axis-2984-color-to-material-inventory §4) — 엠보스 inset +
 * seal(검증/claim 상태) 재질(시안 0bead718 `.stamp`/`.seal` 그대로 토큰화). soft-fill 색
 * 배경(연두 틴트 등)으로 표시하던 claim/검증 상태를 대체하는 재질 프리미티브. seal 색은
 * 여전히 신호(success=녹색 유지, §1 "제거는 신호가 사라지나" 판별 — 도장 자체가 검증
 * "결과"라 색 신호로 남긴다). trust-seal.tsx의 verified 씰(S6, story #3054)이 채택 대상 —
 * 이 파일 자체는 신규 소비처를 만들지 않는다(정의만).
 */
export function VerificationStamp({
  children,
  tone = 'success',
  className,
}: {
  children: React.ReactNode;
  tone?: 'success' | 'neutral';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-[5px] border border-proof-line px-2 py-1 pl-[7px] text-[10px] font-bold tracking-[0.06em] text-muted-foreground uppercase shadow-[var(--elev-inset)]',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-3 shrink-0 items-center justify-center rounded-full border-[1.5px]',
          tone === 'success' ? 'border-success' : 'border-proof-faint',
        )}
      >
        <span className={cn('size-[5px] rounded-full', tone === 'success' ? 'bg-success' : 'bg-proof-faint')} />
      </span>
      {children}
    </span>
  );
}
