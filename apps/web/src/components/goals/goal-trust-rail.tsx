'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { FlaskConical } from 'lucide-react';
import { ProofCapsule, type ProofState } from '@/components/proof-capsule/proof-capsule';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

/**
 * story #2958 §4/§6(doc goals-outcome-ledger-redesign-handoff) — 결과 캡슐(상세) 우측 328px
 * 수직 신뢰 레일. §6 "기전·데이터 동일·새 API 0" 그대로: 이미 있는 `/api/hypotheses?project_id=
 * &epic_id=`(hypotheses-section.tsx와 동일 계약)만 추가 소비 — 이 컴포넌트가 새로 만드는 API는
 * 없다.
 *
 * ⚠️범위 절제(미르코 구현 판단, §8) — 시안 원안엔 "활성화 승인(draft→active gate)" 노드가
 * 있었으나 뺐다. 그라운딩 결과: epic 상태전이는 `evaluate_line_for_transition`(workflow line
 * overlay, org별 enforcing/default-off 설정에 종속)을 타고, doc_approval처럼 org posture와
 * 무관하게 always-manual인 Gate 행이 보장되지 않는다(_ALWAYS_MANUAL_GATE_TYPES에 epic 없음) —
 * 즉 대다수 org에서 실제로는 Gate 행이 아예 생성 안 되고 inline 전이된다. 실측 안 되는 걸
 * 추측으로 채우면(가짜 승인자·날짜) §8 "데이터 있는 만큼만"을 어긴다 — 그 노드는 통째로
 * 뺀다(발명 0 원칙이 이긴다).
 */

interface RailProps {
  outcomeStatus: 'n_a' | 'pending' | 'hit' | 'miss' | 'unmeasured' | 'unmeasurable' | null | undefined;
  measureAfter: string | null | undefined;
  createdAt: string;
  epicId: string;
  projectId: string;
}

const OUTCOME_PROOF: Record<string, ProofState> = {
  hit: 'green', miss: 'blue', unmeasured: 'blue', unmeasurable: 'blue',
};

export function GoalTrustRail({ outcomeStatus, measureAfter, createdAt, epicId, projectId }: RailProps) {
  const t = useTranslations('goals');
  const tOutcome = useTranslations('outcomeLoop');
  const locale = useLocale();
  const [hypCount, setHypCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/hypotheses?project_id=${projectId}&epic_id=${epicId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json) => { if (!cancelled) setHypCount(((json?.data ?? []) as unknown[]).length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [epicId, projectId]);

  // story #3493 — measureAfter(측정 예정)는 "약속"(§11-2 formatScheduledAt),
  // createdAt(생성 기록)은 "기록"(3436 묶음 8 formatRelativeTime) — 한 함수로
  // 뭉뚱그리지 않는다.
  const displayTimezone = resolveDisplayTimezone().tz;
  const fmtScheduled = (s: string) => formatScheduledAt(s, displayTimezone).display;
  const fmtRecord = (s: string) => formatRelativeTime(s, locale, displayTimezone);
  const judged = outcomeStatus && outcomeStatus !== 'n_a' && outcomeStatus !== 'pending';
  // 동적 t() 키 조립(문자열 이어붙이기) 대신 명시 매핑 — 정적 추출·타입 안전 둘 다 지킨다.
  const judgedLabel = outcomeStatus === 'hit' ? tOutcome('statusHit')
    : outcomeStatus === 'miss' ? tOutcome('statusMiss')
    : outcomeStatus === 'unmeasured' ? tOutcome('statusUnmeasured')
    : outcomeStatus === 'unmeasurable' ? tOutcome('statusUnmeasurable')
    : '';

  return (
    <div>
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {t('trustRailTitle')}
      </div>
      <ol className="relative mt-3 space-y-3 border-l border-border pl-4">
        {/* 결과 검증 — 판정 완료(초록/파랑, §8 색규율: hit만 green·나머지 중립/blue) vs 예정(dashed). */}
        <li className="relative">
          <span className={`absolute -left-[19px] top-2 size-2 rounded-full border-2 border-background ${judged ? (outcomeStatus === 'hit' ? 'bg-proof-green' : 'bg-proof-blue') : 'bg-transparent border-dashed border-proof-blue'}`} />
          {judged ? (
            <ProofCapsule
              density="audit"
              proofState={OUTCOME_PROOF[outcomeStatus as string] ?? 'blue'}
              stateLabel={t('outcomeLabel')}
              claim={t('trustRailOutcomeJudged', { label: judgedLabel })}
              now=""
              human={{ name: '', role: '' }}
            />
          ) : (
            <div className="border border-dashed border-proof-blue/40 px-3 py-2">
              <div className="text-[13px] font-bold text-proof-blue">{t('trustRailOutcomePending')}</div>
              {measureAfter ? <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{t('outcomeAwaitingMeasure')} · {fmtScheduled(measureAfter)}</div> : null}
            </div>
          )}
        </li>

        {/* 가설 증거 — HypothesesSection과 동일 엔드포인트 재사용, 개수만(밀집도상 배지 생략). */}
        {hypCount > 0 ? (
          <li className="relative">
            <span className="absolute -left-[19px] top-2 size-2 rounded-full border-2 border-background bg-proof-amber" />
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
              <FlaskConical className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {t('trustRailHypotheses', { count: hypCount })}
            </div>
          </li>
        ) : null}

        {/* 생성 — 항상. created_by 필드가 BE 스키마에 없어(그라운딩 확認) 이름은 안 지어낸다. */}
        <li className="relative">
          {/* story #3053(2984-S5) — KEEP 재검(doc §2): 형제 노드(위 hypotheses)는 solid
              bg-proof-amber인데 이 dot만 -soft(옅은 틴트)라 재질 불일치였다 — dot은 신호라
              유지하되, 솔리드 채도로 정합(제거 아니라 정제). */}
          <span className="absolute -left-[19px] top-2 size-2 rounded-full border-2 border-background bg-proof-blue" />
          <div className="text-[13px] font-medium text-foreground">{t('trustRailCreated')}</div>
          <div className="font-mono text-[11px] text-muted-foreground">{fmtRecord(createdAt)}</div>
        </li>
      </ol>

      <div className="mt-6 border border-border bg-muted/30 p-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t('trustRailColorRuleTitle')}</div>
        <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {/* story #3099(DS·AA 후속) — green 소형텍스트(12px) AA 미달, text-proof-ink로
              중립화(별도 dot 없는 범례 문구 — 텍스트 자체가 이미 규칙을 서술). */}
          <strong className="text-proof-ink">{t('trustRailColorRuleGreen')}</strong> {t('trustRailColorRuleBody')}
        </div>
      </div>
    </div>
  );
}
