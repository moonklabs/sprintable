import { cn } from '@/lib/utils';

/**
 * story #3049(2984-S1, doc diff-axis-2984-color-to-material-inventory §4) — 헤어라인 무채
 * 칩(fill 0). soft-fill 색 배경(`bg-*-soft`)으로 구분하던 카테고리 칩·타입 배지류를 대체하는
 * 재질 프리미티브 1종(시안 0bead718 `.chip-line`/3df21f43 `.type-line` 그대로 토큰화). S2~S6
 * 표면 스토리가 채택 — 이 파일 자체는 신규 소비처를 만들지 않는다(정의만).
 */
export function MaterialChip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      data-slot="material-chip"
      className={cn(
        'inline-flex items-center rounded-md border border-proof-line bg-transparent px-2 py-[3.5px] text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}
