import { cn } from '@/lib/utils';

/**
 * story #3049(2984-S1, doc diff-axis-2984-color-to-material-inventory §4) — 엠보스 inset +
 * seal(검증/claim 상태) 재질(시안 0bead718 `.stamp`/`.seal` 그대로 토큰화). soft-fill 색
 * 배경(연두 틴트 등)으로 표시하던 claim/검증 상태를 대체하는 재질 프리미티브. seal 색은
 * 여전히 신호(success=녹색 유지, §1 "제거는 신호가 사라지나" 판별 — 도장 자체가 검증
 * "결과"라 색 신호로 남긴다).
 *
 * story #2e583f9e(2984-S7, AC4) — S6(#3054)이 처음 "trust-seal.tsx verified 씰이 채택
 * 대상"이라 적었던 건 정정됐다. 유나 확定 정본 규칙: **정보-리치 표면(아바타+텍스트+상태
 * 등 다항목)은 재질 언어(헤어라인+elev)만, compact·dense 표면(단일 배지급)은 이 컴포넌트
 * 실채택** — trust-seal.tsx의 verified/claimed 둘 다 정보-리치라 재질 언어만 채택했다
 * (S6 실구현). 이 컴포넌트의 실 채택처는 **아직 없다** — compact 컨텍스트가 식별되기
 * 전엔 채택하지 않는다(사이트 없이 채택 금지, 유나 verdict 명시). 이 파일 자체는 신규
 * 소비처를 만들지 않는다(정의만).
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
