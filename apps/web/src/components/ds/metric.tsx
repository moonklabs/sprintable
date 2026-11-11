import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icon';

type MetricValue =
  | { /** 값 — 숫자 · 시간 · 금액 등 이미 다듬은 글(비어 있을 수 없다 — 값이 없으면 `unavailable`). */ value: string | number | ReactElement; unavailable?: false; unavailableLabel?: never }
  /** 값을 못 구했다 — «—»만 보이고 «왜 비었나»는 읽히는 글(`unavailableLabel`)로 필수. 0과 «모름»을 섞지 않는다. */
  | { value?: never; unavailable: true; unavailableLabel: string };

export type MetricProps = Omit<HTMLAttributes<HTMLDListElement>, 'children'> & {
  /** 이름 — 필수(작은 글). */
  label: ReactNode;
  /** 이름 앞 아이콘(장식 — 뜻은 이름 글이 싣는다). */
  icon?: IconName;
  /** 아이콘의 뜻 색 — 기본 중립. 끝남 `done` · 실패 `failed` · 안내 `info` · 선택 `action`일 때만(색은 «뜻»이 있을 때만, 이름 글이 같이 간다). */
  iconTone?: 'neutral' | 'done' | 'failed' | 'info' | 'action';
  /** 숫자 뒤 «/한도» — `ink-3`. 예: `limit="40"` → «12 / 40». */
  limit?: ReactNode;
  /** 변화 · 비교 한 칸(보통 `Chip`) — 호출부가 뜻 색을 정한다. */
  delta?: ReactNode;
} & MetricValue;

/**
 * UI-3(a9d56577) Metric — doc v0.3 #31. 카드 안 숫자 칸: 이름(`text-small` `ink-3`) 위 · 숫자(`text-title` 고정폭, 자리 맞춤) 아래 · 뒤에 «/한도»(`ink-3`) · 오른쪽 변화 칸.
 * `dl` 한 쌍이라 스크린리더가 «이름 → 값»으로 읽는다. 값을 못 구하면 «—» + 읽히는 이유. 사용량/한도 막대는 ProgressBar가 선 뒤에 아래에 붙인다.
 */
const ICON_TONE: Record<NonNullable<MetricProps['iconTone']>, string> = {
  neutral: 'text-ds-ink-3',
  done: 'text-ds-done',
  failed: 'text-ds-failed',
  info: 'text-ds-info',
  action: 'text-ds-action-text',
};

export function Metric({ label, icon, iconTone = 'neutral', value, limit, delta, unavailable, unavailableLabel, className, ...props }: MetricProps) {
  // 타입은 빈 값을 막지만(JS · `a?.b` 호출부) 런타임에 null이 오면 빈 칸이 아니라 보이는 «—»로 — 0과 «모름»을 섞지 않는다.
  const missing = !unavailable && (value === null || value === undefined);
  const hasLimit = limit !== null && limit !== undefined && limit !== false;
  const hasDelta = delta !== null && delta !== undefined && delta !== false;
  return (
    <dl data-slot="ds-metric" data-unavailable={unavailable || undefined} className={cn('m-0 min-w-0', className)} {...props}>
      <dt className="flex items-center gap-1.5 text-ds-small text-ds-ink-3">
        {icon ? <Icon name={icon} className={cn('shrink-0', ICON_TONE[iconTone])} /> : null}
        <span className="min-w-0 break-keep [overflow-wrap:anywhere]">{label}</span>
      </dt>
      <dd className="m-0 mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
        {unavailable ? (
          <>
            <span aria-hidden="true" className="font-mono text-ds-title font-semibold tabular-nums text-ds-ink-3">—</span>
            <span className="sr-only">{unavailableLabel}</span>
          </>
        ) : (
          <span className="min-w-0 font-mono text-ds-title font-semibold tabular-nums text-ds-ink [overflow-wrap:anywhere]">{missing ? '—' : value}</span>
        )}
        {/* 흐름 글에 공백을 실어 «12 / 40»으로 읽힌다(CSS gap은 읽는 글이 아니다) — flex 안의 공백 글자는 그려지지 않는다. */}
        {hasLimit && !unavailable ? <>{' '}<span className="min-w-0 font-mono text-ds-mono-lg tabular-nums text-ds-ink-3 [overflow-wrap:anywhere]">/ {limit}</span></> : null}
        {hasDelta && !unavailable ? <>{' '}<span className="ml-auto shrink-0">{delta}</span></> : null}
      </dd>
    </dl>
  );
}
