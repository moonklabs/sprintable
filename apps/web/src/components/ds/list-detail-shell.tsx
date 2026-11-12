'use client';

import type { ReactNode } from 'react';
import { Panel, PanelBody, PanelContent, PanelHeader } from './panel';
import { DialogTitle } from './dialog';

/**
 * story 4909 (UI-R1 AC3) — the home's «list + detail» skeleton as one part, so the inbox's screens stand on the same bones.
 * Wide (`wide`): the list on the left (360–420px) and the picked row's detail on the right, both on screen at once.
 * Narrow: the list alone; a tap on a row lifts the detail as a bottom sheet — never both (the wide column is not drawn on a phone, the sheet is not drawn on a desktop).
 * The caller owns the width decision (`useListDetailWide()` — from 1024px the detail sits beside the list), what is picked and whether the sheet is open: this part only lays them out.
 */
export function ListDetailShell({
  list, detail, wide, detailLabel, sheetLabel, sheetOpen, onSheetOpenChange, testId = 'list-detail', columnTestId, sheetTestId,
}: {
  list: ReactNode;
  detail: ReactNode;
  wide: boolean;
  /** the accessible name of the wide detail column */
  detailLabel: string;
  /** the accessible name (and the screen-reader title) of the narrow sheet */
  sheetLabel: string;
  /** narrow only — the caller passes `false` while nothing is picked, so an empty sheet never opens */
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
  /** `<testId>` on the root; the wide column is `<testId>-detail-column` and the sheet `<testId>-detail-sheet` unless `columnTestId` / `sheetTestId` say otherwise (the home keeps its own ids) */
  testId?: string;
  columnTestId?: string;
  sheetTestId?: string;
}) {
  return (
    <div className="lg:grid lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:items-start lg:gap-4" data-testid={testId}>
      {list}
      {wide ? (
        <aside className="sticky top-4 max-h-[calc(100svh-6rem)]" aria-label={detailLabel} data-testid={columnTestId ?? `${testId}-detail-column`}>
          {detail}
        </aside>
      ) : (
        <Panel open={sheetOpen} onOpenChange={onSheetOpenChange}>
          <PanelContent aria-label={sheetLabel} data-testid={sheetTestId ?? `${testId}-detail-sheet`}>
            <PanelHeader><DialogTitle className="sr-only">{sheetLabel}</DialogTitle></PanelHeader>
            <PanelBody className="p-0">{detail}</PanelBody>
          </PanelContent>
        </Panel>
      )}
    </div>
  );
}
