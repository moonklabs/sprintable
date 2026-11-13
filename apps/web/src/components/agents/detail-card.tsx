'use client';

import type { ReactNode } from 'react';
import { Card } from '@/components/ds/card';
import { cn } from '@/lib/utils';

/**
 * story 4912 (C1) — the agent detail's sub-tab cards on ONE layer: the ds `Card` (LAYER.panel, over the page surface) + a header line (title · status chips · description · one action on the right) + a padded body.
 * It replaces the old `SectionCard` (bg-card + SectionCardHeader/Body) in the detail page's own cards; the text is the ds scale (no text-muted-foreground / text-base).
 * Behaviour, conditions and wording are untouched — only the face.
 */
export function DetailCard({
  title,
  status,
  description,
  action,
  children,
  className,
  'data-testid': testId,
}: {
  /** none = a body-only card (a one-line notice) */
  title?: ReactNode;
  /** chips next to the title (the saved state of the thing) */
  status?: ReactNode;
  description?: ReactNode;
  /** one control on the header's right end */
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <Card data-testid={testId} className={cn('overflow-hidden', className)}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ds-line px-4 py-3" data-slot="detail-card-header">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 text-ds-card-title font-semibold text-ds-ink">{title}</h2>
              {status}
            </div>
            {description ? <p className="m-0 break-keep text-ds-small text-ds-ink-3">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children !== undefined && children !== null ? <div className="space-y-3 px-4 py-3" data-slot="detail-card-body">{children}</div> : null}
    </Card>
  );
}
