'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/ds/avatar';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { EmptyState } from '@/components/ds/empty-state';
import { useFlatHref } from '@/hooks/use-flat-href';
import { withProjectParam } from '@/lib/with-project-param';
import type { HomeModel, HomeRow } from './derive-home';
import type { HomeSources } from './home-model-provider';
import { actionLabel, AGENT_STATUS_KEY, kindLabel, rowTitle, useRowLink } from './home-list';
import { waitedSince } from './waited';

/**
 * story #4888 (UI-5 home, AC3 §1) — the detail column of the home: what the picked row is, shown beside the list (wide) or in a sheet (narrow).
 * Top: who · what kind · how long it has waited. Middle: three blocks that need a hand — the request (the reason, who asked), the target (what is being approved) and — only where the thing
 * cannot be taken back — the undo notice the old row already carried. Bottom: one fixed action line with the SAME action the row had (the link to the approval, the answer, the story)
 * and «무엇을 승인하나요?» above it. Nothing here is invented: every word is a fact the row already had.
 */
export function HomeDetail({ row, model, sources, now, partial = false }: { row: HomeRow | null; model: HomeModel; sources: HomeSources; now: number; partial?: boolean }) {
  const t = useTranslations('home');
  const tb = useTranslations('orgBriefing');
  const flatHref = useFlatHref();
  const linkFor = useRowLink(sources);

  if (!row) {
    // the same rule the list follows: an empty list is «all caught up» only when EVERYTHING was read — a partial read or approvals the server counted but gave no rows for are said in words, never passed off as done
    const hiddenNeedsMe = Math.max(0, sources.snapshot.needsMeCount - sources.snapshot.needsMe.length);
    return (
      <div data-testid="home-detail-empty" className="rounded-ds-control border border-ds-line bg-ds-surface">
        {model.needsHand.length === 0 && partial && hiddenNeedsMe === 0
          ? <p className="m-0 px-4 py-10 text-center text-ds-small text-ds-ink-2" data-testid="home-detail-partial">{tb('loadErrorTitle')}</p>
          : model.needsHand.length === 0 && hiddenNeedsMe > 0
            ? <p className="m-0 px-4 py-10 text-center text-ds-small text-ds-ink-2" data-testid="home-detail-hidden">{tb('needsMeHiddenCountNotice', { count: hiddenNeedsMe })}</p>
            : model.needsHand.length === 0
              ? <EmptyState icon="check_circle" title={t('emptyAllTitle')} description={t('emptyAllDescription')} />
              : <p className="m-0 px-4 py-10 text-center text-ds-small text-ds-ink-3">{t('detailPick')}</p>}
      </div>
    );
  }

  const link = linkFor(row);
  const isNeed = row.kind === 'approval' || row.kind === 'signature' || row.kind === 'answer';
  const need = isNeed ? sources.snapshot.needsMe.find((i) => `${i.source}:${i.id}` === row.key) ?? null : null;
  const run = row.kind === 'agent-run' ? sources.snapshot.agentProgress.find((r) => r.runId === row.ref.id) ?? null : null;
  const statusKey = run ? AGENT_STATUS_KEY[run.status] : undefined;
  const conversationHref = need?.conversationId
    ? (need.conversationProjectId ? withProjectParam(`/chats/${need.conversationId}`, need.conversationProjectId) : flatHref(`/chats/${need.conversationId}`))
    : null;
  const waited = waitedSince(row.since, now);
  const waitedText = waited.unit === 'now' ? t('waitedNow')
    : waited.unit === 'minutes' ? t('waitedMinutes', { count: waited.count })
    : waited.unit === 'hours' ? t('waitedHours', { count: waited.count })
    : t('waitedDays', { count: waited.count });

  return (
    <div data-testid="home-detail" data-row-key={row.key} className="flex min-h-0 flex-col overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface">
      <header className="flex items-start gap-3 border-b border-ds-line px-4 py-3">
        {row.actor ? <Avatar name={row.actor.name} actorType={row.actor.type} size={32} /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="m-0 break-keep text-ds-title font-semibold text-ds-ink [overflow-wrap:anywhere]">{rowTitle(t, row)}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-ds-small text-ds-ink-3">
            <Chip tone={isNeed ? 'needs-hand' : 'neutral'}>{kindLabel(t, row.kind)}</Chip>
            <span data-testid="home-detail-waited">{t('detailWaited', { waited: waitedText })}</span>
            {statusKey ? <span>{tb(statusKey)}</span> : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {need ? (
          <>
            <Card className="p-3" data-testid="home-detail-request">
              <p className="m-0 text-ds-small font-semibold text-ds-ink-3">{t('detailRequest')}</p>
              <p className="m-0 mt-1 break-keep text-ds-body text-ds-ink [overflow-wrap:anywhere]">{need.reason ?? t('detailNoReason')}</p>
              {need.requestedByName ? <p className="m-0 mt-1 text-ds-small text-ds-ink-3">{t('detailRequestedBy', { name: need.requestedByName })}</p> : null}
            </Card>
            <Card className="p-3" data-testid="home-detail-target">
              <p className="m-0 text-ds-small font-semibold text-ds-ink-3">{t('detailTarget')}</p>
              <p className="m-0 mt-1 break-keep text-ds-body text-ds-ink [overflow-wrap:anywhere]">{rowTitle(t, row)}</p>
            </Card>
            {need.state === 'signature' ? (
              <Card className="p-3" data-testid="home-detail-undo">
                <p className="m-0 text-ds-small font-semibold text-ds-ink-3">{t('detailUndo')}</p>
                <p className="m-0 mt-1 text-ds-body text-ds-ink">{tb('signatureRiskNotice')}</p>
              </Card>
            ) : null}
          </>
        ) : (
          <Card className="p-3" data-testid="home-detail-facts">
            <p className="m-0 text-ds-small font-semibold text-ds-ink-3">{t('detailKind')}</p>
            <p className="m-0 mt-1 text-ds-body text-ds-ink">{kindLabel(t, row.kind)}{row.actor?.name ? ` · ${row.actor.name}` : ''}</p>
          </Card>
        )}
      </div>

      {link || conversationHref ? (
        <footer className="border-t border-ds-line bg-ds-surface px-4 py-3" data-testid="home-detail-actions">
          {need ? <p className="m-0 mb-2 text-ds-small text-ds-ink-3">{t('detailWhat')} <span className="text-ds-ink">{rowTitle(t, row)}</span></p> : null}
          <div className="flex flex-wrap items-center gap-2">
            {link ? (
              <Button asChild variant={isNeed ? 'primary' : 'secondary'}>
                <Link href={link.href}>{actionLabel(t, link.action)}</Link>
              </Button>
            ) : null}
            {conversationHref ? <Link href={conversationHref} className="text-ds-small text-ds-action hover:underline">{tb('conversationOpenLink')}</Link> : null}
          </div>
        </footer>
      ) : null}
    </div>
  );
}
