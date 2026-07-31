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
 * backlogTotal(336)은 카드에서 뺐다 — 앞 셋(할 수 있는/주인 없는/승인 대기)은 «행동»(잡을 수
 * 있고·주인을 붙일 수 있고·문을 열 수 있는)인데 backlogTotal은 «배경»이면서 제일 큰 수라
 * 제일 먼저 눈에 들어와 "빚"으로 읽혔다(유나 "분자를 앞에" 원칙 위반) — 목표 목록 위 작은
 * 한 줄로 내렸다.
 *
 * 「승인 대기」 카드는 이제 `/inbox?tab=gates`로 가는 링크다(PO 판정 — 유나 지적:
 * "넷 중 그것만 행동이 없었다", "진입점의 세 약속(이름·가는 곳·세는 것)" 중 가는 곳이
 * 비어 있었다. 게이트는 승인 한 번이면 풀려 다음 고르기보다 싸다). 기존 결재함
 * (reference-decision-gate-approval-ui-path 메모)을 그대로 재사용 — 새 목록 화면을 안 짓는다.
 *
 * story #2352 후속(2026-07-31, 유나 적발) — 이 카드 라벨을 「문이 닫혀 막힌」에서 「승인
 * 대기」로 고쳤다. 옛 라벨의 "막힘"이라는 낱말이, «전혀 다른 표»(WorkflowLineStepApproval)를
 * 세는 관제서랍의 "게이트·막힘 신호"와 같은 낱말을 쓰면서 화면이 자기모순했다(28 vs 0 —
 * 다른 걸 세면서 같은 말을 썼다). 이 값은 `deriveZeroStageStats`의 `blocked` 필드 그대로
 * — Gate 표(requires_human+pending) 기반, epics-progress-lane의 lane.blocked와 동일
 * 정의(derive-next-maker.ts 문서 참고). 관제서랍 쪽(WorkflowLineStepApproval 축)은
 * 사람의 다음 발과 안 이어져 화면에서 통째로 뺐다(flow-client.tsx 참고) — 이름을 바꾸는
 * 게 아니라 그 축 자체를 걷어낸 것.
 *
 * ⛔story #2365 재발(2026-07-31) — 관제서랍이 화면에서 빠졌어도(위 문단) glance 서랍
 * (ExceptionStream, WorkflowLineStepApproval 축)은 여전히 다른 화면(flow-client.tsx)에
 * 산다 — 그 서랍을 펼치면 「승인 대기 30」(이 카드)과 「손 필요한 것 없음」(그 서랍 빈상태)이
 * «같은 화면에» 나란히 선다. 세 번째로 "낱말만 바꾸는" 재발을 막기 위해 이번엔 «무엇을
 * 세는지»를 라벨에 직접 박았다 — 「승인 대기」 → 「게이트 승인 대기」(ccQueueGateApproval과
 * 같은 문구 재사용, DRY). exception-stream.tsx의 「손 필요한 것 없음」도 「승인 흐름(단계
 * 결재)에서 멈춘 것이 없습니다」로 같이 고쳤다 — 한쪽만 고치면 여전히 주어 없이 만난다.
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
        <ZeroStageCell tone="warn" value={zeroStage.blocked} label={t('nextMakerPendingApproval')} href="/inbox?tab=gates" />
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
