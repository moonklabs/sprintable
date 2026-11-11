'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Panel, PanelBody, PanelContent, PanelHeader } from '@/components/ds/panel';
import { DialogTitle } from '@/components/ds/dialog';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { HomeModel } from './derive-home';
import type { HomeSources } from './home-model-provider';
import { HomeDetail } from './home-detail';
import { HomeList } from './home-list';
import { useHomeSelection } from './use-home-selection';
import { useMinuteClock } from './use-minute-clock';

/**
 * story #4888 (UI-5 home, AC3 §1) — the home as a list + a detail column (the «B skeleton»). Wide (≥ 1024): the list on the left (360–420px) and the picked row's detail on the right, both on screen at once.
 * Narrow: the list alone, and a tap on a row lifts the detail up from the bottom as a sheet (never both: the wide column is not drawn on a phone, the sheet is not drawn on a desktop).
 * The first row that needs a hand is picked on the first open (wide: its detail is already beside the list; narrow: nothing opens by itself), and when the picked row is handled the next one is picked.
 */
export function HomeScreen({ model, sources, partial = false }: { model: HomeModel; sources: HomeSources; partial?: boolean }) {
  const t = useTranslations('home');
  const wide = useMediaQuery('(min-width: 1024px)');
  const { selectedKey, select } = useHomeSelection(model);
  const [sheetOpen, setSheetOpen] = useState(false);
  const rows = useMemo(() => [...model.needsHand, ...model.working, ...model.justDone], [model]);
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  const now = useMinuteClock(); // the waited time is shown in whole minutes — the clock is an external store that ticks once a minute

  const onSelect = (key: string) => {
    select(key);
    if (!wide) setSheetOpen(true);
  };

  return (
    <div className="lg:grid lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:items-start lg:gap-4" data-testid="home-screen">
      <HomeList model={model} sources={sources} partial={partial} selectedKey={selectedKey} onSelect={onSelect} />
      {wide ? (
        <aside className="sticky top-4 max-h-[calc(100svh-6rem)]" aria-label={t('detailRequest')} data-testid="home-detail-column">
          <HomeDetail row={selectedRow} model={model} sources={sources} now={now} partial={partial} />
        </aside>
      ) : (
        <Panel open={sheetOpen && selectedRow !== null} onOpenChange={setSheetOpen}>
          <PanelContent aria-label={t('detailSheetLabel', { title: selectedRow?.title ?? '' })} data-testid="home-detail-sheet">
            <PanelHeader><DialogTitle className="sr-only">{t('detailSheetLabel', { title: selectedRow?.title ?? '' })}</DialogTitle></PanelHeader>
            <PanelBody className="p-0"><HomeDetail row={selectedRow} model={model} sources={sources} now={now} partial={partial} /></PanelBody>
          </PanelContent>
        </Panel>
      )}
    </div>
  );
}
