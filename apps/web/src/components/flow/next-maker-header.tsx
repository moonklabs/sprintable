'use client';

import { useTranslations } from 'next-intl';
import type { NextMakerHeadline, ZeroStageStats } from './derive-next-maker';

interface NextMakerHeaderProps {
  headline: NextMakerHeadline;
  zeroStage: ZeroStageStats;
}

/**
 * story #2224 후속(2026-07-31) — 아티팩트 a920c25f v2 ①첫 줄 + ②0단계. 유나 목업 그대로:
 * 곧 멈추는 수(굵게·경고색)가 첫 줄의 강조축, 45는 무채(설명 없이도 실측에서 바로 나온 문장 —
 * PO note ①: "왜 4개뿐인가"의 답을 화면이 스스로 말한다).
 */
export function NextMakerHeader({ headline, zeroStage }: NextMakerHeaderProps) {
  const t = useTranslations('flow');

  return (
    <div className="space-y-3 border-b border-border pb-4">
      <div>
        <p className="text-base font-semibold leading-snug text-foreground">
          {t('nextMakerHeadline', { total: headline.totalGoals, needsNext: headline.needsNextCount })}
          {headline.aboutToStallCount > 0 && (
            <>
              {' — '}
              <b className="font-mono text-amber-600 dark:text-amber-400">
                {t('nextMakerHeadlineStall', { n: headline.aboutToStallCount })}
              </b>
            </>
          )}
        </p>
        {headline.quietCount > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('nextMakerQuietHint', { n: headline.quietCount })}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{t('nextMakerSubline')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <ZeroStageCell tone="brand" value={zeroStage.canDo} label={t('nextMakerCanDo')} />
        <ZeroStageCell tone="info" value={zeroStage.unowned} label={t('nextMakerUnowned')} />
        <ZeroStageCell tone="warn" value={zeroStage.blocked} label={t('nextMakerBlocked')} />
        <ZeroStageCell
          tone="neutral"
          value={zeroStage.backlogTotal}
          label={t('nextMakerBacklog', { owned: zeroStage.backlogOwned })}
        />
      </div>
    </div>
  );
}

function ZeroStageCell({
  tone, value, label,
}: { tone: 'brand' | 'info' | 'warn' | 'neutral'; value: number; label: string }) {
  const borderClass = {
    brand: 'border-l-primary',
    info: 'border-l-info',
    warn: 'border-l-amber-500',
    neutral: 'border-l-border',
  }[tone];
  const valueClass = {
    brand: 'text-primary',
    info: 'text-info',
    warn: 'text-amber-600 dark:text-amber-400',
    neutral: 'text-foreground',
  }[tone];

  return (
    <div className={`min-w-[130px] rounded-md border border-l-[3px] px-3 py-2 ${borderClass}`}>
      <div className={`font-mono text-lg font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
