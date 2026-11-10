'use client';

// story 4891 (UI-8 · settings sections · PO 11-10) — ONE frame for a settings card on the ds parts: Card + SectionHeader (the title) + the one-line description + the body. The notifications tab's cards (the notifications card ·
// the standup deadline · the gate level table · the auto-refresh chips) all stand in it, so the tab is one look. Replaces ui/section-card there (title = h2, as before; the description stays a plain line under the header).
import type { ReactNode } from 'react';
import { Card } from '@/components/ds/card';
import { SectionHeader } from '@/components/ds/section-header';
import { cn } from '@/lib/utils';

export function SettingsSection({ title, description, children, className, id }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <Card id={id} className={cn('overflow-hidden', className)} data-testid={id ? `settings-section-${id}` : undefined}>
      <SectionHeader title={title} level={2} />
      <div className="space-y-3 p-3">
        {description ? <p className="break-keep text-ds-small text-ds-ink-3">{description}</p> : null}
        {children}
      </div>
    </Card>
  );
}
