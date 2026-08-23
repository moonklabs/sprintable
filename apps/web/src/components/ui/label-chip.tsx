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
  // story #2969 §1.4(doc proofline-system-layer-2969) — label-chip.tsx는 §1.4 "proof-cut-xs
  // 소 컷(태그·마커류)" 목록에 badge.tsx/status-badge.tsx와 함께 명시 등재. rounded-full→
  // proof-cut+proof-cut-xs.
  return (
    <span className={cn('proof-cut proof-cut-xs inline-flex items-center gap-1.5 bg-muted px-2 py-0.5 text-xs font-medium text-foreground', className)}>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color ?? '#8A8F98' }}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  );
}
