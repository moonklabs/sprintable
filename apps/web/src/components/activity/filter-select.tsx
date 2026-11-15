'use client';

import { NativeSelect } from '@/components/ds/select';

export interface FilterOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * story 4892 (UI-9 활동) — one filter dropdown of the activity screen's filter row (actor · object · verb): the ds NativeSelect, named by `label` (the old custom dropdown named itself by its placeholder, which a
 * native select does not show once a value is chosen). Same options, same value, same `onValueChange(value)` contract as before.
 */
export function FilterSelect({ value, onValueChange, options, label, className }: {
  value: string;
  onValueChange: (value: string) => void;
  options: FilterOption[];
  label: string;
  className?: string;
}) {
  return (
    <NativeSelect aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)} className={className}>
      {options.map((o) => (<option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </NativeSelect>
  );
}
