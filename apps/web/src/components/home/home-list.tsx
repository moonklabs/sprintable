'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/ds/avatar';
import { Button } from '@/components/ds/button';
import { CountBadge } from '@/components/ds/count-badge';
import { EmptyState } from '@/components/ds/empty-state';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { hrefForNeedsMeItem } from '@/components/org-briefing/derive-today';
import { useFlatHref } from '@/hooks/use-flat-href';
import { withProjectParam } from '@/lib/with-project-param';
import type { HomeModel, HomeRow, HomeRowKind } from './derive-home';
import type { HomeSources } from './home-model-provider';

/**
 * story #4888 (UI-5 AC4, home) — the three sections of the home list: «내 손이 필요해요» (always open, the first 5 rows + «N개 더 보기») · «일하는 중» · «방금 끝남» (both folded at first).
 * Everything here is drawn from the `HomeModel` (`deriveHome`) — the same model the navigation bar's badge reads. A row's action is the link the old screen already had for that thing
 * (the approval details · the notification's own destination · the story on the flow board); nothing new is invented.
 */

/** the word under a row's title that says what kind of thing it is (literal keys, so each one is visibly read) */
function kindLabel(t: ReturnType<typeof useTranslations>, kind: HomeRowKind): string {
  switch (kind) {
    case 'approval': return t('kindApproval');
    case 'signature': return t('kindSignature');
    case 'answer': return t('kindAnswer');
    case 'mention': return t('kindMention');
    case 'assigned': return t('kindAssigned');
    case 'permission': return t('kindPermission');
    case 'stopped': return t('kindStopped');
    case 'limit-paused': return t('kindLimitPaused');
    case 'agent-run': return t('kindAgentRun');
    case 'story': return t('kindStory');
    case 'done': return t('kindDone');
  }
}

/** the agent run statuses the old «에이전트가 하는 일» rows named (an unknown status gets no word — nothing is invented) */
const AGENT_STATUS_KEY: Record<string, string> = {
  queued: 'agentStatusQueued',
  held: 'agentStatusHeld',
  running: 'agentStatusRunning',
  hitl_pending: 'agentStatusHitlPending',
};

type RowAction = 'approve' | 'approveAndSign' | 'answer' | 'open';
function actionLabel(t: ReturnType<typeof useTranslations>, action: RowAction): string {
  switch (action) {
    case 'approve': return t('rowApprove');
    case 'approveAndSign': return t('rowApproveAndSign');
    case 'answer': return t('actionAnswer');
    case 'open': return t('actionOpen');
  }
}
const NEEDS_ACTION: Partial<Record<HomeRowKind, RowAction>> = { approval: 'approve', signature: 'approveAndSign', answer: 'answer' };

function useRowLink(sources: HomeSources): (row: HomeRow) => { action: RowAction; href: string } | null {
  const flatHref = useFlatHref();
  return (row) => {
    switch (row.kind) {
      case 'approval':
      case 'signature':
      case 'answer': {
        const item = sources.snapshot.needsMe.find((i) => `${i.source}:${i.id}` === row.key);
        if (!item) return null;
        return { action: NEEDS_ACTION[row.kind] ?? 'open', href: hrefForNeedsMeItem(item, flatHref) };
      }
      case 'mention':
      case 'assigned':
      case 'permission':
      case 'stopped':
      case 'limit-paused':
        return { action: 'open', href: sources.notificationHrefById[row.ref.id] ?? flatHref('/inbox') };
      case 'story':
        return { action: 'open', href: row.ref.projectId ? withProjectParam(`/flow?story=${row.ref.id}`, row.ref.projectId) : flatHref(`/flow?story=${row.ref.id}`) };
      case 'done': {
        const conversationId = sources.runConversationById[row.ref.id];
        return conversationId ? { action: 'open', href: flatHref(`/chats/${conversationId}`) } : null;
      }
      default:
        return null;
    }
  };
}

function HomeRowView({ row, sources, needsHand }: { row: HomeRow; sources: HomeSources; needsHand: boolean }) {
  const t = useTranslations('home');
  const tb = useTranslations('orgBriefing');
  const flatHref = useFlatHref();
  const linkFor = useRowLink(sources);
  const link = linkFor(row);
  // what the old rows also said: an approval's reason (or who asked), the status word of an agent run, and — on an approval that needs a signature — the notice that it cannot be undone
  const need = needsHand && (row.kind === 'approval' || row.kind === 'signature' || row.kind === 'answer') ? sources.snapshot.needsMe.find((i) => `${i.source}:${i.id}` === row.key) ?? null : null;
  const run = row.kind === 'agent-run' ? sources.snapshot.agentProgress.find((r) => r.runId === row.ref.id) ?? null : null;
  const statusKey = run ? AGENT_STATUS_KEY[run.status] : undefined;
  const conversationHref = need?.conversationId
    ? (need.conversationProjectId ? withProjectParam(`/chats/${need.conversationId}`, need.conversationProjectId) : flatHref(`/chats/${need.conversationId}`))
    : null;
  const subtitle = [kindLabel(t, row.kind), row.actor?.name, need?.reason, statusKey ? tb(statusKey) : null].filter(Boolean).join(' · ');
  const common = {
    leading: row.actor ? <Avatar name={row.actor.name} actorType={row.actor.type} size={24} /> : undefined,
    title: row.title,
    subtitle,
    trailing: link || conversationHref ? (
      <>
        {conversationHref ? <Link href={conversationHref} className="text-ds-small text-ds-action hover:underline">{tb('conversationOpenLink')}</Link> : null}
        {link ? (
          <Button asChild size="md" variant={needsHand ? 'primary' : 'secondary'}>
            <Link href={link.href}>{actionLabel(t, link.action)}</Link>
          </Button>
        ) : null}
      </>
    ) : undefined,
  } as const;
  return (
    <div data-row-key={row.key}>
      {needsHand ? <ListRow {...common} needsHand needsHandLabel={t('needsHandLabel')} /> : <ListRow {...common} />}
      {need?.state === 'signature' ? <p className="m-0 border-b border-ds-line px-4 pb-2 text-ds-small text-ds-ink-3">{tb('signatureRiskNotice')}</p> : null}
    </div>
  );
}

function FoldableSection({ title, rows, sources, defaultCollapsed, emptyText }: { title: string; rows: HomeRow[]; sources: HomeSources; defaultCollapsed: boolean; emptyText: string }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <section aria-label={title}>
      <SectionHeader title={title} count={<CountBadge count={rows.length} />} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} level={2} />
      {collapsed ? null : rows.length === 0 ? (
        <p className="m-0 px-4 py-6 text-center text-ds-small text-ds-ink-3">{emptyText}</p>
      ) : (
        <div>{rows.map((row) => <HomeRowView key={row.key} row={row} sources={sources} needsHand={false} />)}</div>
      )}
    </section>
  );
}

export function HomeList({ model, sources, partial = false }: { model: HomeModel; sources: HomeSources; partial?: boolean }) {
  const t = useTranslations('home');
  const tb = useTranslations('orgBriefing');
  const [showAll, setShowAll] = useState(false);
  // the server counted more waiting approvals than it gave rows for (an item without its key facts is left out): never shown as «all caught up» — the difference is said in words, and is not in the one number
  const hiddenNeedsMe = Math.max(0, sources.snapshot.needsMeCount - sources.snapshot.needsMe.length);
  const visible = showAll ? model.needsHand : model.needsHandVisible;
  return (
    <div className="overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface" data-testid="home-list">
      <p className="m-0 px-4 py-2 font-mono text-ds-mono-md text-ds-ink-3" data-testid="home-header-line">
        {t('headerLine', { needsHand: model.header.needsHand, working: model.header.working, justDone: model.header.justDone })}
      </p>
      <section aria-label={t('sectionNeedsHand')} data-testid="home-section-needs-hand">
        <SectionHeader
          title={t('sectionNeedsHand')}
          tone="needs-hand"
          level={2}
          count={<CountBadge kind="needs-hand" label={t('needsHandLabel')} count={model.header.needsHand} data-testid="home-needs-hand-count" />}
          // the old section said it beside its title when there were rows: money and outbound sends are signed one at a time
          trailing={model.needsHand.length > 0 ? <span data-testid="home-needs-hand-hint">{tb('needsMeHint')}</span> : undefined}
        />
        {model.needsHand.length === 0 && hiddenNeedsMe === 0 && partial ? (
          // some of what feeds this list could not be read: an empty list is not «all caught up»
          <p className="m-0 px-4 py-6 text-center text-ds-small text-ds-ink-2" data-testid="home-partial-empty">{tb('loadErrorTitle')}</p>
        ) : model.needsHand.length === 0 && hiddenNeedsMe === 0 ? (
          <EmptyState icon="check_circle" title={t('emptyAllTitle')} description={t('emptyAllDescription')} />
        ) : model.needsHand.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-ds-small text-ds-ink-2" data-testid="home-hidden-notice">{tb('needsMeHiddenCountNotice', { count: hiddenNeedsMe })}</p>
        ) : (
          <div>
            {visible.map((row) => <HomeRowView key={row.key} row={row} sources={sources} needsHand />)}
            {model.needsHandHidden > 0 ? (
              <div className="border-b border-ds-line px-4 py-2">
                <Button type="button" variant="quiet" aria-expanded={showAll} onClick={() => setShowAll((s) => !s)}>
                  {showAll ? t('lessRows') : t('moreRows', { count: model.needsHandHidden })}
                </Button>
              </div>
            ) : null}
            {hiddenNeedsMe > 0 ? <p className="m-0 border-b border-ds-line px-4 py-2 text-ds-small text-ds-ink-3" data-testid="home-hidden-notice">{tb('needsMeHiddenCountNotice', { count: hiddenNeedsMe })}</p> : null}
          </div>
        )}
      </section>
      <FoldableSection title={t('sectionWorking')} rows={model.working} sources={sources} defaultCollapsed emptyText={t('emptyWorking')} />
      <FoldableSection title={t('sectionJustDone')} rows={model.justDone} sources={sources} defaultCollapsed emptyText={t('emptyJustDone')} />
    </div>
  );
}
