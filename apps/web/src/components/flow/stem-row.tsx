'use client';

import { useTranslations } from 'next-intl';
import type { GoalStem } from './derive-next-maker';

interface StemRowProps {
  stem: GoalStem;
  isExpanded: boolean;
  onToggle: () => void;
}

/**
 * story #2224 AC1 후속(2026-07-31, PO 정정 — 승격/전환 「동사」는 살리되 «화면 전체를 이
 * 목표 하나로 바꾸는» 포커스는 뺀다) — 갈래 캔버스의 몸통은 FlowMultiLaneCanvas로 옮겨갔고,
 * 이 행은 이제 NextActionsStrip 안에서 «이 목표의 승격/전환 패널을 펴고 접는» 토글이다
 * (예전엔 클릭이 화면 오른쪽 전체를 이 목표의 캔버스로 바꿨다 — 지금은 그 자리에 캔버스가
 * 없다, GoalStemCard가 showCanvas=false로 붙는다).
 */
export function StemRow({ stem, isExpanded, onToggle }: StemRowProps) {
  const t = useTranslations('flow');
  const accentClass = stem.priority === 'about-to-stall'
    ? 'border-l-amber-500'
    : stem.hasNext ? 'border-l-emerald-500' : 'border-l-border';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={`w-full rounded-lg border border-l-[3px] px-2.5 py-2 text-left transition ${accentClass} ${
        isExpanded ? 'bg-muted' : 'hover:bg-muted/50'
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
