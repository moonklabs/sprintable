'use client';

import { useTranslations } from 'next-intl';
import { EntityPreviewModal } from '@/components/chat/embed-card';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { isPanelId } from './panel-path';
import { usePanelWorkItem, type PanelWorkItem } from './use-panel-work-item';

/**
 * story 5042 (C9) — the page inside the desktop app's work-item tab: ONE story, the one the agent works on now, drawn with the web's own reading view (`EntityPreviewModal embedded bare`).
 * Nothing else is on the page: no frame, no close button, no link out. States: loading · none (the agent has no story now) · error (with a retry) · the story. An address that is not a uuid is not opened.
 */
export function WorkItemPanel({ agentId }: { agentId: string }) {
  return <WorkItemPanelOf key={agentId} agentId={agentId} />; // an address with another agent is a new page: its state starts over
}

function WorkItemPanelOf({ agentId }: { agentId: string }) {
  const state = usePanelWorkItem(agentId);
  return <PanelStateView agentId={agentId} state={state} retry={state.retry} />;
}

/** what the page draws for a state of the read (a plain view: the layout spec draws it with fixed states) */
export function PanelStateView({ agentId, state, retry }: { agentId: string; state: PanelWorkItem; retry: () => void }) {
  const t = useTranslations('desktopPanel');
  if (!isPanelId(agentId)) return <PanelNote testId="panel-bad-address">{t('badAddress')}</PanelNote>;
  if (state.phase === 'loading') return <PanelNote testId="panel-loading">{t('loading')}</PanelNote>;
  if (state.phase === 'none') return <PanelNote testId="panel-none">{t('noActive')}</PanelNote>;
  if (state.phase === 'error') {
    return (
      <div className="p-4" data-testid="panel-error">
        <Banner tone="failed" action={<Button size="md" variant="secondary" onClick={retry}>{t('retry')}</Button>}>{t('loadErrorTitle')}</Banner>
      </div>
    );
  }
  return (
    <div className="h-svh" data-testid="panel-work-item">
      {/* keyed by the story: the agent moving on to the next one is a new page of the reading view (its own read starts over) */}
      <EntityPreviewModal key={state.storyId} entityType="story" entityId={state.storyId} title={null} status={null} href={null} onClose={() => undefined} embedded bare />
    </div>
  );
}

function PanelNote({ testId, children }: { testId: string; children: React.ReactNode }) {
  return <p className="p-4 text-sm text-ds-ink-muted" data-testid={testId}>{children}</p>;
}
