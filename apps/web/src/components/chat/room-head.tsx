'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { useMediaQuery } from '@/hooks/use-media-query';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface RoomHeadChip {
  id: string;
  /** the participant's avatar (small) + name — the part owns only the pill around them */
  who: ReactNode;
  /** the one word that says how the participant is — a ds StatusLabel for an agent (connected · idle · offline); a person has none (no presence data exists for people) */
  state?: ReactNode;
}

export interface RoomHeadProps {
  /** a channel: the people button's two counts when the head folds into it (a short window) */
  peopleParts?: RoomPeopleParts;
  /**
   * story 5031 (C1 step 5b): the room's NAME is not in the head any more — from lg it is the last crumb of the top bar's path and that is the screen's one `h1`. The head keeps what the bar does not carry: the facts line and the people. The only name-related thing left here is the way to CHANGE
   * the name (a group room's rename): the caller passes its control (a pencil button; the input while editing) — absent for a room whose name cannot be changed. It is a control, not a heading: this head draws no heading at all.
   */
  rename?: ReactNode;
  /** the small tag at the start of the line — «프로젝트 방» · «DM» · «그룹» */
  tag?: string | null;
  /** the line of facts: project · people */
  subline?: string | null;
  chips: RoomHeadChip[];
  /** how many participants did not fit (shown as «+N») */
  moreCount?: number;
  addLabel: string;
  /** absent while the room's data is not there (loading · blocked): a «+» that does nothing is not drawn */
  onAdd?: () => void;
  /** the right end: the muted state and the «⋯» menu — the head itself has no other button */
  trailing?: ReactNode;
  /** story 4946 — in a SHORT window (under 600 px high) the chip row folds into a «people N» button + popover (the fixed button name and the count): both given = the fold is available */
  peopleLabel?: string;
  peopleCount?: number;
}

/**
 * story 4887 (UI-4 screen PR · the approved layout B3) — the room head inside the room's column: a tag, ONE line of facts and a row of participant chips (story 5031 5b: the name moved to the top bar's path — see `rename`).
 * story 5031 (C1 step 2b, kit numbers): at least 80 high (`min-h-20`: the chip row may still make it taller) with 24 on each side (`px-6`).
 * It carries no button of its own except the «+» that ends the chip row (add a participant) and whatever the caller puts at the right end («⋯»). From lg up only — a phone gets RoomBarTitle in the shell's header row.
 */
export function RoomHead({ rename, tag, subline, chips, moreCount = 0, addLabel, onAdd, trailing, peopleLabel, peopleCount, peopleParts }: RoomHeadProps) {
  // story 4946 — in a SHORT window (under 600 px high) the chip row is replaced by the «people N» button; the same content is never drawn twice (a media query in JS, not a hidden copy: one set of testids · one tab order)
  const short = useMediaQuery('(max-height: 600px)');
  const folded = short && Boolean(peopleLabel) && (peopleCount ?? 0) > 0;
  return (
    // below lg (the phone shell) this head is NOT drawn: the room's name · people · «⋯» live in the shell's own 48 px header row (RoomBarTitle) — a second head under it cost 135 px of reading column
    // story 5048 T0 ①: the controls are 40 px — the kit head is 80 (min-h-20). Folded (short window) the content is two rows of 40-px controls (62), so py-2 (16) lands it on exactly 80; py-3 would make it 86
    // story 5048 (chat row · PO 11-27): the head is TWO lines — (the rename pencil) · tag · the line of facts · «⋯» on the first (the name is the bar's h1 since 5b), the people chips on the second (it was name / facts / chips = three, ≈170 px with the chip rows). The numbers in the facts line are the text's own font (tabular), not the fixed-width one.
    <header data-testid="room-head" className={`min-h-20 flex-shrink-0 border-b border-ds-line px-6 max-lg:hidden ${folded ? 'pb-1.5 pt-2' : 'pb-2 pt-2'}`}>
      <div className="flex min-w-0 items-center gap-2">
        {rename ? <div className="flex min-w-0 shrink-0 items-center" data-testid="room-head-rename">{rename}</div> : null}
        {tag ? <Chip data-testid="room-head-tag">{tag}</Chip> : null}
        {subline ? <p className="m-0 min-w-0 shrink-[3] truncate text-ds-mono-md tabular-nums text-ds-ink-3" data-testid="room-head-subline">{subline}</p> : null}
        {/* story 4946 — only in a short window: the people button that the chip row folds into */}
        {folded ? (
          <RoomPeoplePopover peopleLabel={peopleLabel!} peopleCount={peopleCount!} peopleParts={peopleParts} chips={chips} moreCount={moreCount} addLabel={addLabel} onAdd={onAdd} />
        ) : null}
        {trailing ? <div className="ml-auto flex flex-shrink-0 items-center gap-1">{trailing}</div> : null}
      </div>
      {folded ? null : (
      <ul className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="room-head-chips">
        {chips.map((c) => (
          <li key={c.id} data-testid="room-head-chip" className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-ds-control border border-ds-line px-2 text-ds-small text-ds-ink">
            {c.who}
            {c.state ?? null}
          </li>
        ))}
        {moreCount > 0 ? <li data-testid="room-head-more" className="text-ds-mono-md tabular-nums text-ds-ink-3">+{moreCount}</li> : null}
        {onAdd ? <li><IconButton icon="add" label={addLabel} onClick={onAdd} data-testid="room-head-add" className="size-ds-tag" /></li> : null}
      </ul>
      )}
    </header>
  );
}

/** story 5032 (C2 · PO 11-27, the second look at 390): a CHANNEL's button draws two counts, each with its own glyph and name — «사람 2 · 에이전트 1» — instead of the one number «3» that left people and agents indistinguishable */
export interface RoomPeopleParts { people: number; agents: number; /** what a reader hears for the two numbers — the channel head's own «사람 N · 부를 수 있는 에이전트 N» line (the drawn glyphs + numbers are aria-hidden) */ spoken: string }

interface RoomPeoplePopoverProps {
  peopleLabel: string;
  peopleCount: number;
  /** a channel: the button shows the two counts apart (the sum is still the sr-only «참여자 보기» count of the room) */
  peopleParts?: RoomPeopleParts;
  chips: RoomHeadChip[];
  moreCount?: number;
  addLabel: string;
  onAdd?: () => void;
  /** a line above the people (the phone puts the room's tag and facts here; the desktop head already shows them) */
  header?: ReactNode;
  className?: string;
}

/**
 * The «people N» button and its popover (the participants with their words · the «+»): ONE part for the phone's room bar and for the desktop head in a SHORT window (story 4946 — the chip row folds into this when the window is under 600 px high:
 * nothing is lost, the people are one press away). No people yet (the room is still loading) → nothing is drawn.
 */
export function RoomPeoplePopover({ peopleLabel, peopleCount, peopleParts, chips, moreCount = 0, addLabel, onAdd, header, className }: RoomPeoplePopoverProps) {
  const [open, setOpen] = useState(false); // controlled: the «+» must close the popover BEFORE the add dialog opens (two layers stacked = two Escape presses)
  if (peopleCount <= 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="quiet" title={peopleLabel} data-testid="room-bar-people" iconStart={<Icon name="groups" size="sm" />} className={`shrink-0 px-2 ${className ?? ''}`} />}>
        {/* the name the reader hears is «참여자 보기 3»: the fixed label (sr-only) + the number (visible) */}
        <span className="sr-only">{peopleLabel} </span>
        {peopleParts ? (
          <span className="flex items-center gap-1.5" data-testid="room-bar-people-parts">
            <span className="sr-only">{peopleParts.spoken}</span>
            <span className="flex items-center gap-0.5" aria-hidden="true"><Icon name="person" size={14} /><span className="text-ds-mono-md tabular-nums" data-testid="room-bar-people-humans">{peopleParts.people}</span></span>
            <span className="flex items-center gap-0.5" aria-hidden="true"><Icon name="smart_toy" size={14} /><span className="text-ds-mono-md tabular-nums" data-testid="room-bar-people-agents">{peopleParts.agents}</span></span>
          </span>
        ) : (
          <span className="text-ds-mono-md tabular-nums">{peopleCount}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={peopleLabel} className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 p-3" data-testid="room-bar-people-popup">
        {header}
        <ul className="flex flex-col gap-1.5" data-testid="room-head-chips">
          {chips.map((c) => (
            <li key={c.id} data-testid="room-head-chip" className="inline-flex min-h-7 max-w-full items-center gap-1.5 text-ds-small text-ds-ink">
              {c.who}
              {c.state ?? null}
            </li>
          ))}
          {moreCount > 0 ? <li data-testid="room-head-more" className="text-ds-mono-md tabular-nums text-ds-ink-3">+{moreCount}</li> : null}
        </ul>
        {onAdd ? <Button variant="secondary" iconStart={<Icon name="add" size="md" />} onClick={() => { setOpen(false); onAdd(); }} data-testid="room-head-add">{addLabel}</Button> : null}
      </PopoverContent>
    </Popover>
  );
}

export interface RoomBarTitleProps {
  backLabel: string;
  /** a channel: the people button's two counts (people · agents) */
  peopleParts?: RoomPeopleParts;
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
export function RoomBarTitle({ backLabel, onBack, title, tag, subline, peopleLabel, peopleCount, peopleParts, chips, moreCount = 0, addLabel, onAdd }: RoomBarTitleProps) {
  return (
    // the shell's title slot clips its direct child (truncate): this wrapper lets the focus rings out; the name itself truncates
    <div data-testid="room-bar" className="flex min-w-0 items-center gap-1 !overflow-visible">
      <IconButton icon="arrow_back" label={backLabel} onClick={onBack} className="-ml-2 shrink-0" data-testid="room-bar-back" />
      <h1 className="m-0 min-w-0 truncate text-ds-body font-semibold text-ds-ink">{title}</h1>
      {/* a room always has someone in it: no people yet (the room is still loading) → no «0» button */}
      {/* a room always has someone in it: no people yet (the room is still loading) → no «0» button */}
      <RoomPeoplePopover
        peopleLabel={peopleLabel}
        peopleCount={peopleCount}
        peopleParts={peopleParts}
        chips={chips}
        moreCount={moreCount}
        addLabel={addLabel}
        onAdd={onAdd}
        header={tag || subline ? (
          <p className="flex min-w-0 items-center gap-2 text-ds-small text-ds-ink-3">
            {tag ? <Chip data-testid="room-head-tag">{tag}</Chip> : null}
            {subline ? <span className="min-w-0 truncate text-ds-mono-md tabular-nums" data-testid="room-head-subline">{subline}</span> : null}
          </p>
        ) : null}
      />
    </div>
  );
}
