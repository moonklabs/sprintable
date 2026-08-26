import { cn } from '@/lib/utils';

export interface LabelData {
  id: string;
  name: string;
  color: string | null;
}

export const LABEL_PRESET_COLORS = [
  '#E8833A',
  '#C6493B',
  '#3E7DC2',
  '#4C9A6A',
  '#B59A3C',
  '#8A8F98',
] as const;

export function LabelChip({ label, className }: { label: LabelData; className?: string }) {
  // story #7d7634ee(P0·선생님 직접 지시, 감確認 doc ea94dac4) — 코너컷 폐지, 소프트 라운드+
  // 그레인+엠보스(proof-surface-press, "씰/칩" doc §⑤ 명시 예시)로 교체.
  return (
    <span className={cn('proof-surface proof-surface-press inline-flex items-center gap-1.5 bg-muted px-2 py-0.5 text-xs font-medium text-foreground', className)}>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color ?? '#8A8F98' }}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  );
}
