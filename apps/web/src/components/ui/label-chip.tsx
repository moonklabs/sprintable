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
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground', className)}>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color ?? '#8A8F98' }}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  );
}
