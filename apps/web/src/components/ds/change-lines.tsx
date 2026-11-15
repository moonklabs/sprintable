import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * story 4949 — ChangeLines: the lines of a change, one row each — «＋ added» · «－ removed» · a plain note row. One view part for «what an agent is
 * about to write / change» (the approval card) and «what it changed» (the changed-files view): the rows are data, the part only draws them.
 * Never colour alone: every row starts with a mark («＋» «－») and carries a screen-reader word; the tint (`done-soft` · `failed-soft`) only
 * helps the eye. Lines wrap (a phone is 390 wide — a code block that scrolls sideways hides the end of the line the person is asked about);
 * an empty line keeps its height. The text is DATA (monospace); the marks and the note are text of the part's caller.
 */
export type ChangeRow =
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'note'; text: string };

export interface ChangeLinesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  rows: readonly ChangeRow[];
  /** the group's accessible name (what these lines are) */
  label: string;
  /** the screen-reader words read before an added / removed row */
  words: { add: string; del: string };
}

const ROW = 'flex gap-2 px-2 py-0.5';

export function ChangeLines({ rows, label, words, className, ...props }: ChangeLinesProps) {
  return (
    <div role="group" aria-label={label} data-slot="ds-change-lines" className={cn('overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface text-ds-mono-md text-ds-ink', className)} {...props}>
      {rows.map((row, i) => row.kind === 'note' ? (
        <p key={i} data-row="note" className={cn(ROW, 'font-sans text-ds-small text-ds-ink-3')}>{row.text}</p>
      ) : (
        <p key={i} data-row={row.kind} className={cn(ROW, 'font-mono', row.kind === 'add' ? 'bg-ds-done-soft' : 'bg-ds-failed-soft')}>
          <span aria-hidden="true" className={cn('w-3 shrink-0 select-none text-center font-semibold', row.kind === 'add' ? 'text-ds-done' : 'text-ds-failed')}>{row.kind === 'add' ? '+' : '−'}</span>
          <span className="sr-only">{row.kind === 'add' ? words.add : words.del}: </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{row.text === '' ? ' ' : row.text}</span>
        </p>
      ))}
    </div>
  );
}
