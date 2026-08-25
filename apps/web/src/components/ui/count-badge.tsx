import { cn } from '@/lib/utils';

/**
 * story #3049(2984-S1, doc diff-axis-2984-color-to-material-inventory §4) — mono·엠보스
 * inset 카운트 배지(시안 3df21f43 `.badge-count` 그대로 토큰화). soft-fill 색 배경으로
 * 강조하던 카운트류(그룹 배지 「38건」 등)를 대체하는 재질 프리미티브. S4~S5 표면 스토리가
 * 채택 — 이 파일 자체는 신규 소비처를 만들지 않는다(정의만).
 */
export function CountBadge({ count, suffix, className }: { count: number; suffix?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-0.5 rounded-full border border-proof-line px-2.5 py-[3px] font-mono text-xs font-bold text-foreground shadow-[var(--elev-inset)]',
        className,
      )}
    >
      {count}
      {suffix ? <span className="text-[9px] font-medium text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}
