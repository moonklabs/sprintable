import type { HTMLAttributes, LiHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type TimelineName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };

export type TimelineProps = Omit<HTMLAttributes<HTMLOListElement>, 'aria-label' | 'aria-labelledby'> & TimelineName;

/**
 * UI-3(a9d56577) Timeline — doc v0.3 #28. 세로선(`line`) 위에 점 7px이 꿰이고, 한 줄 = 시각(`mono-md`) + 행위자(Avatar 18 — 호출부가 칸에 넣는다) + 문장(`text-ds-body`).
 * 날짜 묶음은 호출부가 `SectionHeader`로 나눠 목록을 여러 개 놓는다(이 부품은 한 묶음의 목록). 이름(`aria-label` | `aria-labelledby`)이 필수다.
 * 점 색은 뜻(끝남 `done` · 손 필요 `needs-hand-bar` · 그 밖 `action`)이지만 색만으로 말하지 않는다 — 뜻이 있는 줄은 읽히는 글(`toneLabel`)이 필수다.
 */
export function Timeline({ className, ...props }: TimelineProps) {
  return <ol {...props} data-slot="ds-timeline" className={cn('m-0 list-none p-0', className)} />;
}

type ItemBase = Omit<LiHTMLAttributes<HTMLLIElement>, 'children'> & {
  /** 시각 글(이미 다듬은 글 — 예: «14:02»). */
  time: ReactNode;
  /** `<time datetime>`에 실을 기계가 읽는 값(ISO). 없으면 `<time>` 요소를 쓰지 않는다. */
  dateTime?: string;
  /** 행위자 칸(보통 `<Avatar size={18} decorative … />`) — 이름이 문장에 글로 있으면 장식으로 둔다. */
  actor?: ReactNode;
  /** 문장. */
  children: ReactNode;
};
type ItemTone =
  | { tone?: 'default'; toneLabel?: string }
  /** 뜻이 있는 점은 색만으로 말하지 않는다 — 화면에 안 보이는 글(예: «끝남» · «내 손이 필요»)이 필수. */
  | { tone: 'done' | 'needs-hand'; toneLabel: string };
export type TimelineItemProps = ItemBase & ItemTone;

const DOT: Record<'default' | 'done' | 'needs-hand', string> = {
  default: 'bg-ds-action',
  done: 'bg-ds-done',
  'needs-hand': 'bg-ds-needs-hand-bar',
};

export function TimelineItem({ time, dateTime, actor, tone = 'default', toneLabel, children, className, ...props }: TimelineItemProps) {
  const cue = tone !== 'default' && toneLabel ? <span className="sr-only">{toneLabel} </span> : null;
  return (
    <li
      {...props}
      data-slot="ds-timeline-item"
      data-tone={tone}
      className={cn(
        'relative pb-3 pl-5 last:pb-0',
        // 세로선: 위 아래 이웃과 이어지고, 첫 줄은 점에서 시작해 마지막 줄은 점에서 끝난다.
        'before:absolute before:left-[3px] before:top-0 before:bottom-0 before:w-px before:bg-ds-line first:before:top-2.5 last:before:bottom-auto last:before:h-2.5',
        className,
      )}
    >
      <span aria-hidden="true" data-slot="ds-timeline-dot" className={cn('absolute left-0 top-2 size-[7px] rounded-full', DOT[tone])} />
      <div className="flex min-w-0 items-start gap-2">
        {dateTime ? (
          <time dateTime={dateTime} className="shrink-0 font-mono text-ds-mono-md leading-5 tabular-nums text-ds-ink-3">{time}</time>
        ) : (
          <span className="shrink-0 font-mono text-ds-mono-md leading-5 tabular-nums text-ds-ink-3">{time}</span>
        )}
        {actor ? <span data-slot="ds-timeline-actor" className="mt-0.5 shrink-0">{actor}</span> : null}
        <p className="m-0 min-w-0 flex-1 break-keep text-ds-body text-ds-ink [overflow-wrap:anywhere]">
          {cue}
          {children}
        </p>
      </div>
    </li>
  );
}
