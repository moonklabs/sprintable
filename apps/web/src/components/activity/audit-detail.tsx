'use client';

import { forwardRef, useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { IconButton } from '@/components/ds/icon-button';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import type { ActivityLogItem } from './activity-log-view';

interface AuditDetailProps {
  item: ActivityLogItem;
  /** the person's reading name for the actor row (the list already built it, with the «· ID 앞 8자» tail for two equal names). */
  actorLabel: string | null;
  /** the id the row button's `aria-controls` points to. */
  id: string;
  /** the one-line claim the row shows — the detail's heading repeats it so a screen reader knows what the region is about. */
  claim: string;
  onClose: () => void;
}

/**
 * story 4892 (UI-9 활동 §2) — the audit row's original action name and its context key/values used to live ONLY in a hover tooltip (`title`): invisible on touch
 * and to the keyboard. They are a visible, focusable region now: a labelled `section` the row's `aria-expanded` / `aria-controls` button points to, with the same
 * facts as a definition list. New data 0 — it is exactly what the tooltip carried, plus the target, the actor and the time the row already had.
 */
export const AuditDetail = forwardRef<HTMLElement, AuditDetailProps>(function AuditDetail({ item, actorLabel, id, claim, onClose }, ref) {
  const t = useTranslations('activityLog');
  const locale = useLocale();
  // the same fallback as the day grouping (UTC while the viewer's zone is unknown) — a row grouped under a day must show a date on that day
  const tz = useViewerTimeZone() ?? 'UTC';
  const headingId = useId();
  const context = item.context ? Object.entries(item.context) : [];
  const target = item.entity_title
    ? (item.entity_type ? `${item.entity_type} · ${item.entity_title}` : item.entity_title)
    : item.entity_type;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(item.created_at));
  return (
    <section ref={ref} id={id} tabIndex={-1} aria-labelledby={headingId} data-testid="audit-detail" className="rounded-ds-panel border border-ds-line bg-ds-surface p-4 outline-none focus-visible:ring-2 focus-visible:ring-ds-action">
      <div className="flex items-start gap-2">
        <h2 id={headingId} className="m-0 min-w-0 flex-1 break-words text-ds-card-title font-semibold text-ds-ink">{claim}</h2>
        <IconButton icon="close" label={t('detailClose')} onClick={onClose} />
      </div>
      <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-ds-small">
        <dt className="text-ds-ink-3">{t('detailAction')}</dt>
        <dd className="m-0 break-all font-mono text-ds-mono-md text-ds-ink">{item.action}</dd>
        {target ? (<><dt className="text-ds-ink-3">{t('detailTarget')}</dt><dd className="m-0 break-words text-ds-ink">{target}</dd></>) : null}
        {actorLabel ? (<><dt className="text-ds-ink-3">{t('detailActor')}</dt><dd className="m-0 break-words text-ds-ink">{actorLabel}</dd></>) : null}
        <dt className="text-ds-ink-3">{t('detailWhen')}</dt>
        <dd className="m-0 text-ds-ink">{when} <span className="text-ds-ink-3">· {formatViewerRelativeTime(item.created_at, locale, tz)}</span></dd>
      </dl>
      <h3 className="mb-1 mt-4 text-ds-small font-semibold text-ds-ink-2">{t('detailContext')}</h3>
      {context.length === 0 ? (
        <p className="m-0 text-ds-small text-ds-ink-3">{t('detailNoContext')}</p>
      ) : (
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-ds-mono-md" data-testid="audit-detail-context">
          {context.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ds-ink-3">{k}</dt>
              <dd className="m-0 break-all text-ds-ink">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
});
