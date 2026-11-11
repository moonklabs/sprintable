'use client';

import type { ReactNode } from 'react';
import { Chip } from '@/components/ds/chip';
import { IconButton } from '@/components/ds/icon-button';

export interface RoomHeadChip {
  id: string;
  /** the participant's avatar (small) + name — the part owns only the pill around them */
  who: ReactNode;
  /** the one word that says how the participant is — a ds StatusLabel for an agent (connected · idle · offline); a person has none (no presence data exists for people) */
  state?: ReactNode;
}

export interface RoomHeadProps {
  /** phone only: the way back to the list */
  backLabel: string;
  onBack: () => void;
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
 * It carries no button of its own except the phone's «back», the «+» that ends the chip row (add a participant) and whatever the caller puts at the right end («⋯»).
 */
export function RoomHead({ backLabel, onBack, title, tag, subline, chips, moreCount = 0, addLabel, onAdd, trailing }: RoomHeadProps) {
  return (
    <header data-testid="room-head" className="flex-shrink-0 border-b border-ds-line px-4 pb-2 pt-3">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton icon="arrow_back" label={backLabel} onClick={onBack} className="-ml-1 lg:hidden" data-testid="room-head-back" />
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
