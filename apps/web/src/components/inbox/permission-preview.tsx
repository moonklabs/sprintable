'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ChangeLines, type ChangeRow } from '@/components/ds/change-lines';
import type { PermissionPreview } from '@/lib/agent-permissions';

/** story 4949: the rows shown before «더 보기» — a phone's sheet shows the file name, the lines and the buttons without scrolling */
export const PREVIEW_FOLDED_ROWS = 8;

type T = (key: string, values?: Record<string, string | number>) => string;

/** the preview as rows: removed lines, added lines, and a note for what was left out (counted, never guessed) */
export function previewRows(p: PermissionPreview, t: T): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const b of p.blocks) {
    for (const text of b.removed) rows.push({ kind: 'del', text });
    if (b.removed_more > 0) rows.push({ kind: 'note', text: t('preview.moreRemoved', { count: b.removed_more }) });
    for (const text of b.added) rows.push({ kind: 'add', text });
    if (b.added_more > 0) rows.push({ kind: 'note', text: t('preview.moreAdded', { count: b.added_more }) });
  }
  if (p.blocks_more > 0) rows.push({ kind: 'note', text: t('preview.moreEdits', { count: p.blocks_more }) });
  if (p.replace_all) rows.push({ kind: 'note', text: t('preview.replaceAll') });
  return rows;
}

export function PermissionPreviewView({ preview }: { preview: PermissionPreview }) {
  const t = useTranslations('agentPermissions');
  const [open, setOpen] = useState(false);
  if (preview.withheld) {
    return <p className="break-keep text-pretty text-xs text-muted-foreground" data-testid="agent-permission-preview-withheld">{t('preview.withheld')}</p>;
  }
  const rows = previewRows(preview, t as unknown as T);
  if (rows.length === 0) return null;
  const folded = rows.length > PREVIEW_FOLDED_ROWS && !open;
  const shown = folded ? rows.slice(0, PREVIEW_FOLDED_ROWS) : rows;
  const hidden = rows.length - PREVIEW_FOLDED_ROWS;
  return (
    <div className="space-y-1.5" data-testid="agent-permission-preview">
      <p className="text-xs font-medium text-foreground">{t(preview.op === 'write' ? 'preview.writeTitle' : 'preview.editTitle')}</p>
      <ChangeLines rows={shown} label={t(preview.op === 'write' ? 'preview.writeTitle' : 'preview.editTitle')} words={{ add: t('preview.added'), del: t('preview.removed') }} />
      {rows.length > PREVIEW_FOLDED_ROWS ? (
        <Button type="button" variant="ghost" size="sm" className="touch:min-h-11 touch:px-4" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="agent-permission-preview-toggle">
          {open ? t('preview.fold') : t('preview.unfold', { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}
