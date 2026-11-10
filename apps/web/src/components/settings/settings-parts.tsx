'use client';

// story 4891 (UI-8 · settings) — two small parts the settings cards share, on ds tokens, built for a phone: a 12 px status tag (the ds Chip is the 11 px mono kind) and a 44 px switch (the ds Button's touch floor around the 24 px track).
import type { ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { cn } from '@/lib/utils';

const TAG_TONE = {
  neutral: 'bg-ds-surface-high text-ds-ink-2',
  done: 'bg-ds-done-soft text-ds-done',
  'needs-hand': 'bg-ds-needs-hand-soft text-ds-needs-hand',
  failed: 'bg-ds-failed-soft text-ds-failed',
  action: 'bg-ds-action-soft text-ds-action-text',
} as const;

/** a small status tag on the ds meaning tokens, at 12 px (a phone reads nothing under 12 here) */
export function Tag({ tone = 'neutral', children, className }: { tone?: keyof typeof TAG_TONE; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-6 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-ds-tag border border-ds-line px-1.5 text-ds-small font-semibold', TAG_TONE[tone], className)}><span className="min-w-0 truncate">{children}</span></span>;
}

/** an on/off switch: `role=switch` + `aria-checked` on a ds Button (≥ 44 × 44 on touch), the picture a 44 × 24 track. The accessible name is the caller's `aria-label` (or `aria-labelledby`). */
export function SwitchButton({ checked, onCheckedChange, disabled, className, ...aria }: { checked: boolean; onCheckedChange: (next: boolean) => void; disabled?: boolean; className?: string; 'aria-label'?: string; 'aria-labelledby'?: string }) {
  return (
    <Button
      {...aria}
      type="button"
      variant="quiet"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn('h-8 w-12 border-transparent p-0 pointer-coarse:h-11 pointer-coarse:w-14', className)}
    >
      <span className={cn('relative h-6 w-11 rounded-full border transition', checked ? 'border-ds-action bg-ds-action' : 'border-ds-line-control bg-ds-surface-high')}>
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </Button>
  );
}
