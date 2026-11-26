'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { CardFrame, type CardFrameState } from './card-frame';
import { DeployCardFace } from './deploy-card';
import type { DeploySummary, DeployWrite } from './deploy-access';
import { EntityCardFace } from './entity-card';
import { KanbanCardFace } from './kanban-card';
import type { KanbanSummary } from './kanban-summary';
import { RefusedCardFace } from './refused-card';

/**
 * story 5034 (C4) — the state toggle the story closes on: ONE place to flip a chat card of EACH KIND (an object · a sprint board · the project-membership card · a refused card) through [default · loading ·
 * empty · error · not visible · long text] and between a phone width (390) and a desktop width (1440). It draws the same parts a message does (CardFrame · the kinds' faces) with fixed example words — no reads,
 * and the project-membership card's two buttons act on a local stand-in (nothing is written anywhere). Shown on /design-system.
 */
type Shown = 'ready' | 'loading' | 'empty' | 'error' | 'hidden' | 'long';
type Kind = 'entity' | 'kanban' | 'deploy' | 'refused';
export const SHOWCASE_WIDTHS = { narrow: 390, wide: 1440 } as const;

/** the membership card on a local stand-in: «넣기» / «빼기» flip the picture the way the real writes do (a clean 201 / 2xx), and touch nothing */
function ShowcaseDeploy({ name }: { name: string }) {
  const [summary, setSummary] = useState<DeploySummary>({ name, active: true, access: 'granted', recordId: 'sample-record' });
  const done = (applied: DeployWrite['applied']) => { if (applied) setSummary((s) => ({ ...s, ...applied })); };
  const actions = {
    place: async (): Promise<DeployWrite> => ({ result: 'ok', applied: { access: 'granted', recordId: 'sample-record' } }),
    takeOut: async (): Promise<DeployWrite> => ({ result: 'ok', applied: { access: 'none', recordId: null } }),
  };
  return <DeployCardFace key={`${summary.access}`} summary={summary} canAct projectId="showcase" agentId="showcase" onChanged={done} actions={actions} />;
}

export function CardStatesShowcase() {
  const t = useTranslations('chats');
  const [kind, setKind] = useState<Kind>('entity');
  const [shown, setShown] = useState<Shown>('ready');
  const [wide, setWide] = useState(false);
  const frameState: CardFrameState = shown === 'long' ? 'ready' : shown;
  const long = shown === 'long';
  const board: KanbanSummary = {
    title: long ? t('cardSampleLong') : t('cardSampleBoardTitle'), status: 'active', total: 73, hasMore: false,
    counts: { backlog: 4, 'ready-for-dev': 2, 'in-progress': 3, 'in-review': 1, done: 63 },
    now: [{ id: 'sample-1', number: 5034, title: t('cardSampleBoardNow') }],
  };
  const face = kind === 'kanban' ? <KanbanCardFace summary={board} />
    : kind === 'deploy' ? <ShowcaseDeploy name={long ? t('cardSampleLong') : t('cardSampleAgent')} />
    : kind === 'refused' ? <RefusedCardFace kind="story" title={long ? t('cardSampleLong') : t('cardSampleTitle')} agentName={t('cardSampleAgent')} seers={[t('cardSampleSeerA'), t('cardSampleSeerB')]} />
    : <EntityCardFace kind="story" statusLabel={t('cardSampleStatus')} title={long ? t('cardSampleLong') : t('cardSampleTitle')} />;
  return (
    <section data-testid="chat-card-states-showcase" className="mt-6 min-w-0">
      <h2 className="m-0 mb-2 text-ds-card-title font-semibold text-ds-ink">{t('cardShowcaseTitle')}</h2>
      <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-label={t('cardShowcaseTitle')} data-testid="chat-card-states-kinds">
        <Button size="md" variant={kind === 'entity' ? 'primary' : 'secondary'} aria-pressed={kind === 'entity'} onClick={() => setKind('entity')}>{t('cardKindEntity')}</Button>
        <Button size="md" variant={kind === 'kanban' ? 'primary' : 'secondary'} aria-pressed={kind === 'kanban'} onClick={() => setKind('kanban')}>{t('cardKindKanban')}</Button>
        <Button size="md" variant={kind === 'deploy' ? 'primary' : 'secondary'} aria-pressed={kind === 'deploy'} onClick={() => setKind('deploy')}>{t('cardKindDeploy')}</Button>
        <Button size="md" variant={kind === 'refused' ? 'primary' : 'secondary'} aria-pressed={kind === 'refused'} onClick={() => setKind('refused')}>{t('cardKindRefused')}</Button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button size="md" variant={shown === 'ready' ? 'primary' : 'secondary'} aria-pressed={shown === 'ready'} onClick={() => setShown('ready')}>{t('cardStateReady')}</Button>
        <Button size="md" variant={shown === 'loading' ? 'primary' : 'secondary'} aria-pressed={shown === 'loading'} onClick={() => setShown('loading')}>{t('cardStateLoading')}</Button>
        <Button size="md" variant={shown === 'empty' ? 'primary' : 'secondary'} aria-pressed={shown === 'empty'} onClick={() => setShown('empty')}>{t('cardStateEmpty')}</Button>
        <Button size="md" variant={shown === 'error' ? 'primary' : 'secondary'} aria-pressed={shown === 'error'} onClick={() => setShown('error')}>{t('cardStateError')}</Button>
        <Button size="md" variant={shown === 'hidden' ? 'primary' : 'secondary'} aria-pressed={shown === 'hidden'} onClick={() => setShown('hidden')}>{t('cardStateHidden')}</Button>
        <Button size="md" variant={shown === 'long' ? 'primary' : 'secondary'} aria-pressed={shown === 'long'} onClick={() => setShown('long')}>{t('cardStateLong')}</Button>
        <Button size="md" variant={wide ? 'secondary' : 'primary'} aria-pressed={!wide} onClick={() => setWide(false)}>{t('cardWidthNarrow')}</Button>
        <Button size="md" variant={wide ? 'primary' : 'secondary'} aria-pressed={wide} onClick={() => setWide(true)}>{t('cardWidthWide')}</Button>
      </div>
      <div data-testid="chat-card-states-stage" data-card-kind={kind} style={{ width: wide ? SHOWCASE_WIDTHS.wide : SHOWCASE_WIDTHS.narrow, maxWidth: '100%' }}>
        {frameState === 'ready' ? face : <CardFrame state={frameState} onRetry={() => setShown('ready')} data-testid={`chat-card-${kind}`} />}
      </div>
    </section>
  );
}
