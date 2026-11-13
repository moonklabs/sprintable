'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { CountBadge } from '@/components/ds/count-badge';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { ContextMenu, ContextMenuTrigger, MenuContent, MenuItem, MenuSeparator } from '@/components/ds/menu';
import type { IconName } from '@/components/ds/icon-paths';
import { handleListKeys } from '@/lib/list-keys';

/**
 * story 4909 (UI-R1 AC3, 결재함) — the list column of the approvals queue: one compact row per request (kind chip · one-line title · mono sub-line · what happened to it), grouped in the
 * sections the AC2 sheet drew («내 손이 필요해요» · «보류 중»). Pure display: the screen decides which row is picked and what each row says; the detail column shows everything about the picked row.
 * j / k / ↑ / ↓ walk the rows (the same helper the home uses — no new command key); a click anywhere on a row, or Enter on its title, picks it.
 */
/** one entry of a row's right-click menu — an action the detail column ALSO has (never a right-click-only action) */
export interface GateQueueMenuItem {
  id: 'approve' | 'reject' | 'hold' | 'open';
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
}

export interface GateQueueRow {
  key: string;
  /** the kind chip («판단 요청» · «PR 리뷰» · a gate type word · «승인 요청») */
  chip: string;
  title: string;
  /** the mono second line («#22a4a6b0 · 2시간 전») */
  subtitle: string;
  /** what already happened to it in this session («승인 완료» · «반려됨») — shown instead of the age chip */
  doneLabel?: string;
  /** the right-click menu of this row (empty / absent → the browser's own menu stays) — the screen decides what the request allows */
  menu?: GateQueueMenuItem[];
}

export interface GateQueueSection {
  id: 'hand' | 'perm' | 'held';
  title: string;
  rows: GateQueueRow[];
}

function GateQueueRowView({ row, section, selected, onSelect, onOpen }: { row: GateQueueRow; section: GateQueueSection['id']; selected: boolean; onSelect: (key: string) => void; onOpen?: (key: string) => void }) {
  const t = useTranslations('home');
  const needsHand = section === 'hand' && !row.doneLabel;
  const common = {
    leading: <Chip tone={needsHand ? 'needs-hand' : 'neutral'}>{row.chip}</Chip>,
    // the title is a real button: Tab reaches it, Enter picks the row (the same as a click on the row)
    title: (
      <Button type="button" variant="quiet" className="h-auto max-w-full justify-start px-0 text-left text-ds-body font-semibold text-ds-ink hover:bg-transparent hover:text-ds-ink focus-visible:ring-0">
        <span className="truncate">{row.title}</span>
      </Button>
    ),
    subtitle: row.subtitle,
    trailing: row.doneLabel ? <Chip tone="done">{row.doneLabel}</Chip> : undefined,
  } as const;
  const rowEl = (
    <>
      {needsHand
        ? <ListRow {...common} selected={selected} needsHand needsHandLabel={t('needsHandLabel')} className="has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-ds-action" />
        : <ListRow {...common} selected={selected} className="has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-ds-action" />}
    </>
  );
  const rowProps = { 'data-row-key': row.key, 'data-testid': 'gate-queue-row', onClick: () => onSelect(row.key), onDoubleClick: onOpen ? () => onOpen(row.key) : undefined };
  if (!row.menu || row.menu.length === 0) return <div {...rowProps}>{rowEl}</div>;
  const decide = row.menu.filter((m) => m.id !== 'open');
  const open = row.menu.filter((m) => m.id === 'open');
  return (
    // the right-click menu — the same ds ContextMenu the storage screen uses; its entries are actions the detail column has too (approve · reject · hold · open the page)
    <ContextMenu>
      <ContextMenuTrigger render={<div {...rowProps} />}>{rowEl}</ContextMenuTrigger>
      <MenuContent align="start">
        {decide.map((m) => <MenuItem key={m.id} icon={m.icon} disabled={m.disabled} onClick={m.onSelect}>{m.label}</MenuItem>)}
        {decide.length > 0 && open.length > 0 ? <MenuSeparator /> : null}
        {open.map((m) => <MenuItem key={m.id} icon={m.icon} disabled={m.disabled} onClick={m.onSelect}>{m.label}</MenuItem>)}
      </MenuContent>
    </ContextMenu>
  );
}

export function GateQueueList({ sections, selectedKey, onSelect, onOpen, footer }: { sections: GateQueueSection[]; selectedKey: string | null; onSelect: (key: string) => void; /** a double-click on a row opens the request's own page (the screen decides where) */ onOpen?: (key: string) => void; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface" data-testid="gate-queue-list" onKeyDown={(e) => handleListKeys(e, onSelect)}>
      {sections.filter((s) => s.rows.length > 0).map((section) => (
        <section key={section.id} aria-label={section.title} data-testid={`gate-queue-section-${section.id}`}>
          <SectionHeader title={section.title} count={<CountBadge count={section.rows.length} />} tone={section.id === 'hand' ? 'needs-hand' : 'default'} level={2} />
          <div>{section.rows.map((row) => <GateQueueRowView key={row.key} row={row} section={section.id} selected={row.key === selectedKey} onSelect={onSelect} onOpen={onOpen} />)}</div>
        </section>
      ))}
      {footer}
    </div>
  );
}
