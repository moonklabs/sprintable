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
 *
 * ⛔결함 fix(2026-07-31, PO 판정 — 선생님 "이게 뭔지.." 라이브 지적 후속, 2차) — 헤드라인
 * 문장 셋을 하나로 줄였다. 「22개는 이미 끝났을 수 있습니다」·「한 번에 다 정하지 않아도
 * 됩니다」는 전부 «설명»이라 "화면이 변명으로 시작"했다(PO) — 각각 3순위 목표 목록 옆
 * (next-maker-screen.tsx)·다음 고르기가 실제로 열린 자리(goal-stem-card.tsx)로 옮겼다.
 *
 * backlogTotal(336)은 카드에서 뺐다 — 앞 셋(할 수 있는/주인 없는/막힘)은 «행동»(잡을 수
 * 있고·주인을 붙일 수 있고·문을 열 수 있는)인데 backlogTotal은 «배경»이면서 제일 큰 수라
 * 제일 먼저 눈에 들어와 "빚"으로 읽혔다(유나 "분자를 앞에" 원칙 위반) — 목표 목록 위 작은
 * 한 줄로 내렸다.
 *
 * 「문이 닫혀 막힌」 카드는 이제 `/inbox?tab=gates`로 가는 링크다(PO 판정 — 유나 지적:
 * "넷 중 그것만 행동이 없었다", "진입점의 세 약속(이름·가는 곳·세는 것)" 중 가는 곳이
 * 비어 있었다. 게이트는 승인 한 번이면 풀려 다음 고르기보다 싸다). 기존 결재함
 * (reference-decision-gate-approval-ui-path 메모)을 그대로 재사용 — 새 목록 화면을 안 짓는다.
 */
export function NextMakerHeader({ headline, zeroStage }: NextMakerHeaderProps) {
  const t = useTranslations('flow');

  return (
    <div className="space-y-3 border-b border-border pb-4">
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

      <div className="flex flex-wrap gap-2">
        <ZeroStageCell tone="brand" value={zeroStage.canDo} label={t('nextMakerCanDo')} />
        <ZeroStageCell tone="info" value={zeroStage.unowned} label={t('nextMakerUnowned')} />
        <ZeroStageCell tone="warn" value={zeroStage.blocked} label={t('nextMakerBlocked')} href="/inbox?tab=gates" />
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t('nextMakerBacklogLine', { n: zeroStage.backlogTotal, owned: zeroStage.backlogOwned })}
      </p>
    </div>
  );
}

function ZeroStageCell({
  tone, value, label, href,
}: { tone: 'brand' | 'info' | 'warn' | 'neutral'; value: number; label: string; href?: string }) {
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

  const content = (
    <>
      <div className={`font-mono text-lg font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </>
  );
  const className = `min-w-[130px] rounded-md border border-l-[3px] px-3 py-2 ${borderClass} ${href ? 'transition hover:bg-muted' : ''}`;

  return href ? <a href={href} className={className}>{content}</a> : <div className={className}>{content}</div>;
}
