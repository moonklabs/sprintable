'use client';

import { useTranslations } from 'next-intl';
import type { GoalStem } from './derive-next-maker';

interface StemRowProps {
  stem: GoalStem;
  isFocused: boolean;
  onFocus: (epicId: string) => void;
}

/**
 * 결함 fix(2026-07-31, 선생님 "이게 뭔지.." 지적 후속 — PO 판정 "①갈래를 화면 절반 이상으로,
 * 머리:갈래=1:3 이하") — 줄기 목록을 «좁은 왼쪽 열»로 내리고, 선택된 줄기의 갈래 캔버스가
 * «넓은 오른쪽»의 몸통이 되도록 분리했다. 이 컴포넌트는 그 왼쪽 열의 행 하나 — 클릭하면
 * 자기 캔버스를 펼치는 게 아니라 «포커스»만 바꾼다(펼침 로직은 GoalStemCard가 오른쪽에서 전담).
 */
export function StemRow({ stem, isFocused, onFocus }: StemRowProps) {
  const t = useTranslations('flow');
  const accentClass = stem.priority === 'about-to-stall'
    ? 'border-l-amber-500'
    : stem.hasNext ? 'border-l-emerald-500' : 'border-l-border';

  return (
    <button
      type="button"
      onClick={() => onFocus(stem.epicId)}
      className={`w-full rounded-lg border border-l-[3px] px-2.5 py-2 text-left transition ${accentClass} ${
        isFocused ? 'bg-muted' : 'hover:bg-muted/50'
      }`}
    >
      <div className="truncate text-[12.5px] font-semibold text-foreground">{stem.title}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {stem.inProgressCount > 0 && (
          <Flag tone="info" label={t('nextMakerFlagInProgress', { n: stem.inProgressCount })} />
        )}
        {stem.waitingCount > 0 && (
          <Flag tone="neutral" label={t('nextMakerFlagWaiting', { n: stem.waitingCount })} />
        )}
        {stem.priority === 'recently-active' && (
          <Flag tone="brand" label={t('nextMakerFlagRecentlyClosed')} />
        )}
        {stem.hasNext && (
          <Flag tone="brand" label={t('nextMakerFlagHasNext', { n: stem.readyForDevCount })} />
        )}
      </div>
    </button>
  );
}

function Flag({ tone, label }: { tone: 'info' | 'neutral' | 'brand' | 'warn'; label: string }) {
  const cls = {
    info: 'border-info/50 text-info',
    neutral: 'border-border text-muted-foreground',
    brand: 'border-primary/50 text-primary font-semibold',
    warn: 'border-amber-500/50 text-amber-600 dark:text-amber-400 font-semibold',
  }[tone];
  return <span className={`rounded border px-1 py-0.5 font-mono text-[9.5px] ${cls}`}>{label}</span>;
}
