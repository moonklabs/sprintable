'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface RoomHeadChip {
  id: string;
  /** the participant's avatar (small) + name — the part owns only the pill around them */
  who: ReactNode;
  /** the one word that says how the participant is — a ds StatusLabel for an agent (connected · idle · offline); a person has none (no presence data exists for people) */
  state?: ReactNode;
}

export interface RoomHeadProps {
  /** the room's name (an `h1` is drawn around it; the caller passes the editable / plain variant) */
  title: ReactNode;
  /** the small tag after the name — «프로젝트 방» · «DM» · «그룹» */
  tag?: string | null;
  /** the line under the name: project · people */
  subline?: string | null;
  chips: RoomHeadChip[];
  /** how many participants did not fit (shown as «+N») */
  moreCount?: number;
  addLabel: string;
  /** absent while the room's data is not there (loading · blocked): a «+» that does nothing is not drawn */
  onAdd?: () => void;
  /** the right end: the muted state and the «⋯» menu — the head itself has no other button */
  trailing?: ReactNode;
}

/**
 * story 4887 (UI-4 screen PR · the approved layout B3) — the room head inside the room's column: the name, a tag, ONE line of facts and a row of participant chips.
 * It carries no button of its own except the «+» that ends the chip row (add a participant) and whatever the caller puts at the right end («⋯»). From lg up only — a phone gets RoomBarTitle in the shell's header row.
 */
export function RoomHead({ title, tag, subline, chips, moreCount = 0, addLabel, onAdd, trailing }: RoomHeadProps) {
  return (
    // below lg (the phone shell) this head is NOT drawn: the room's name · people · «⋯» live in the shell's own 48 px header row (RoomBarTitle) — a second head under it cost 135 px of reading column
    <header data-testid="room-head" className="flex-shrink-0 border-b border-ds-line px-4 pb-2 pt-3 max-lg:hidden">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="m-0 min-w-0 truncate text-ds-card-title font-semibold text-ds-ink">{title}</h1>
        {tag ? <Chip data-testid="room-head-tag">{tag}</Chip> : null}
        {trailing ? <div className="ml-auto flex flex-shrink-0 items-center gap-1">{trailing}</div> : null}
      </div>
      {subline ? <p className="mt-0.5 truncate font-mono text-ds-mono-md text-ds-ink-3" data-testid="room-head-subline">{subline}</p> : null}
      <ul className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="room-head-chips">
        {chips.map((c) => (
          <li key={c.id} data-testid="room-head-chip" className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-ds-control border border-ds-line px-2 text-ds-small text-ds-ink">
            {c.who}
            {c.state ?? null}
          </li>
        ))}
        {moreCount > 0 ? <li data-testid="room-head-more" className="font-mono text-ds-mono-md text-ds-ink-3">+{moreCount}</li> : null}
        {onAdd ? <li><IconButton icon="add" label={addLabel} onClick={onAdd} data-testid="room-head-add" /></li> : null}
      </ul>
    </header>
  );
}

export interface RoomBarTitleProps {
  backLabel: string;
  onBack: () => void;
  /** the room's name (an `h1` is drawn around it) */
  title: ReactNode;
  tag?: string | null;
  subline?: string | null;
  /** the people button's FIXED name («참여자 보기») — the number is drawn beside it, never inside the string (the count-in-title rule) */
  peopleLabel: string;
  peopleCount: number;
  chips: RoomHeadChip[];
  moreCount?: number;
  addLabel: string;
  onAdd?: () => void;
}

/**
 * story 4887 (UI-4) — the room head on a PHONE (below lg): the shell's header row (h-12) takes it as the page title — `← name  [people N]` — with the «⋯» menu in the row's actions beside the bell. The old way (the head as a second block under the shell row) cost 135 px of reading column
 * (390 × 844: 635 → 482). The participants (chips with their connection words) and the «+» are one press away in a popover instead of a row of their own.
 */
export function RoomBarTitle({ backLabel, onBack, title, tag, subline, peopleLabel, peopleCount, chips, moreCount = 0, addLabel, onAdd }: RoomBarTitleProps) {
  const [open, setOpen] = useState(false); // controlled: the «+» must close the popover BEFORE the add dialog opens (two layers stacked = two Escape presses)
  return (
    // the shell's title slot clips its direct child (truncate): this wrapper lets the focus rings out; the name itself truncates
    <div data-testid="room-bar" className="flex min-w-0 items-center gap-1 !overflow-visible">
      <IconButton icon="arrow_back" label={backLabel} onClick={onBack} className="-ml-2 shrink-0" data-testid="room-bar-back" />
      <h1 className="m-0 min-w-0 truncate text-ds-body font-semibold text-ds-ink">{title}</h1>
      {/* a room always has someone in it: no people yet (the room is still loading) → no «0» button */}
      {peopleCount > 0 ? (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="quiet" title={peopleLabel} data-testid="room-bar-people" iconStart={<Icon name="groups" size={16} />} className="shrink-0 px-2" />}>
          {/* the name the reader hears is «참여자 보기 3»: the fixed label (sr-only) + the number (visible) */}
          <span className="sr-only">{peopleLabel} </span>
          <span className="font-mono text-ds-mono-md">{peopleCount}</span>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label={peopleLabel} className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 p-3" data-testid="room-bar-people-popup">
          {tag || subline ? (
            <p className="flex min-w-0 items-center gap-2 text-ds-small text-ds-ink-3">
              {tag ? <Chip data-testid="room-head-tag">{tag}</Chip> : null}
              {subline ? <span className="min-w-0 truncate font-mono text-ds-mono-md" data-testid="room-head-subline">{subline}</span> : null}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1.5" data-testid="room-head-chips">
            {chips.map((c) => (
              <li key={c.id} data-testid="room-head-chip" className="inline-flex min-h-7 max-w-full items-center gap-1.5 text-ds-small text-ds-ink">
                {c.who}
                {c.state ?? null}
              </li>
            ))}
            {moreCount > 0 ? <li data-testid="room-head-more" className="font-mono text-ds-mono-md text-ds-ink-3">+{moreCount}</li> : null}
          </ul>
          {onAdd ? <Button variant="secondary" iconStart={<Icon name="add" size={16} />} onClick={() => { setOpen(false); onAdd(); }} data-testid="room-head-add">{addLabel}</Button> : null}
        </PopoverContent>
      </Popover>
      ) : null}
    </div>
  );
}
