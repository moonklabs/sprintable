'use client';

import { Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * story 4675 (UX-1 · F2 · Yuna §I ①) — which computer an agent is bound to, as one muted chip: the computer's name as the
 * desktop setup gave it (no word of its own) · the name is the spoken label's heart («{name}에 연결됨»). No name → nothing
 * drawn (an agent with no live desktop key · a human · an older server). The same chip in the new-conversation modal, the
 * workforce list and the conversation list, so two agents with one name are told apart by their computer.
 */
export function DeviceChip({ name, className }: { name: string | null | undefined; className?: string }) {
  const t = useTranslations('desktop');
  if (!name) return null;
  return (
    <Badge
      variant="chip"
      className={cn('max-w-40 shrink-0 gap-1 font-normal text-muted-foreground', className)}
      title={name}
      aria-label={t('deviceChipAria', { name })}
      data-testid="device-chip"
    >
      <Monitor className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </Badge>
  );
}
