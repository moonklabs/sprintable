'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ListDetailShell } from '@/components/ds/list-detail-shell';
import { useListDetailWide } from '@/hooks/use-list-detail-wide';
import type { HomeModel } from './derive-home';
import type { HomeSources } from './home-model-provider';
import { HomeDetail } from './home-detail';
import { HomeList, rowTitle } from './home-list';
import { useHomeSelection } from './use-home-selection';
import { useMinuteClock } from './use-minute-clock';

/**
 * story #4888 (UI-5 home, AC3 §1) — the home as a list + a detail column (the «B skeleton»). Wide (≥ 1024): the list on the left (360–420px) and the picked row's detail on the right, both on screen at once.
 * Narrow: the list alone, and a tap on a row lifts the detail up from the bottom as a sheet (never both: the wide column is not drawn on a phone, the sheet is not drawn on a desktop).
 * The first row that needs a hand is picked on the first open (wide: its detail is already beside the list; narrow: nothing opens by itself), and when the picked row is handled the next one is picked.
 */
export function HomeScreen({ model, sources, partial = false }: { model: HomeModel; sources: HomeSources; partial?: boolean }) {
  const t = useTranslations('home');
  const wide = useListDetailWide();
  const { selectedKey, select } = useHomeSelection(model);
  const [sheetOpen, setSheetOpen] = useState(false);
  const rows = useMemo(() => [...model.needsHand, ...model.working, ...model.justDone], [model]);
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;
  const now = useMinuteClock(); // the waited time is shown in whole minutes — the clock is an external store that ticks once a minute

  const onSelect = (key: string) => {
    select(key);
    if (!wide) setSheetOpen(true);
  };

  const sheetLabel = t('detailSheetLabel', { title: selectedRow ? rowTitle(t, selectedRow) : '' });

  return (
    <ListDetailShell
      testId="home-screen"
      columnTestId="home-detail-column"
      sheetTestId="home-detail-sheet"
      wide={wide}
      list={<HomeList model={model} sources={sources} partial={partial} selectedKey={selectedKey} onSelect={onSelect} />}
      detail={<HomeDetail row={selectedRow} model={model} sources={sources} now={now} partial={partial} />}
      detailLabel={t('detailRequest')}
      sheetLabel={sheetLabel}
      sheetOpen={sheetOpen && selectedRow !== null}
      onSheetOpenChange={setSheetOpen}
    />
  );
}
