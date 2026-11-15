'use client';

import Link from 'next/link';
import { Button } from '@/components/ds/button';
import { cn } from '@/lib/utils';

export interface DocModeSwitchProps {
  /** which side the person is on — that side is drawn pressed and carries aria-current="page". */
  mode: 'read' | 'edit';
  readHref: string;
  editHref: string;
  readLabel: string;
  editLabel: string;
  /** accessible name of the pair. */
  groupLabel: string;
  className?: string;
}

/**
 * story 4892 (UI-9 상세 열) — «읽기 | 고치기» one pair in the detail header, on BOTH screens. Before, the two screens each had a different, separately
 * found link (the reader had «편집»; the editor had an icon-only «미리보기» eye) — now they are one labelled pair whose current side is visible and
 * which sits in the same place on the reading screen and the editing screen. Both sides are links (a page change), the current one is `aria-current`.
 */
export function DocModeSwitch({ mode, readHref, editHref, readLabel, editLabel, groupLabel, className }: DocModeSwitchProps) {
  const item = (side: 'read' | 'edit', href: string, label: string) => (
    <Button asChild variant={mode === side ? 'secondary' : 'quiet'} className="h-6 px-2">
      <Link href={href} aria-current={mode === side ? 'page' : undefined}>{label}</Link>
    </Button>
  );
  return (
    <div role="group" aria-label={groupLabel} data-slot="doc-mode-switch" className={cn('inline-flex shrink-0 gap-0.5 rounded-ds-control border border-ds-line bg-ds-surface-sunk p-0.5', className)}>
      {item('read', readHref, readLabel)}
      {item('edit', editHref, editLabel)}
    </div>
  );
}
