'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { GateItem } from '@/components/kanban/types';

/**
 * H1-S8 머지 verdict 게이트 evidence(read-only 표시). 3 surface(GateInbox row·story detail·
 * approve/reject facts) 공용. 신규 화면 0 — decision 배지 + facts(CI·신뢰도) + 사유.
 *
 * 🔑 핵심 가드(AC③): 신뢰도 None=`null`은 "데이터 없음"으로만 표시한다. 0%/빨강/낮음으로
 * 절대 환원하지 않는다(null≠0 — 미측정과 0은 다르다). CI 미상도 동형(? 알 수 없음).
 * 플랫폼은 위험도 판단을 하지 않는다(neutral_facts = 관찰 사실).
 *
 * decision 배지 3종(BE decision = auto_merge|ask_human|block). gate status=pending(미transition)은
 * ask_human "확인 필요"로 통합(유나 정합 노트 — 별도 "대기" 배지 불필요). 리뷰 증거는 gate 응답에
 * 미노출이라 v1 제외(억지 "없음"=오정보·디디 follow-up). evidence_status는 배지 X·맥락 보조만.
 */

type Decision = 'auto_merge' | 'ask_human' | 'block';

const DECISION_META: Record<Decision, { variant: 'success' | 'warning' | 'destructive'; mark: string; labelKey: string }> = {
  auto_merge: { variant: 'success', mark: '✓', labelKey: 'decisionAutoMerge' },
  ask_human: { variant: 'warning', mark: '⏸', labelKey: 'decisionAskHuman' },
  block: { variant: 'destructive', mark: '⛔', labelKey: 'decisionBlock' },
};

const DECISIONS = new Set(['auto_merge', 'ask_human', 'block']);

/** auto_decision_reason(raw decision) 우선. 미상 + status=pending → ask_human 통합. 그 외 null. */
export function gateDecision(gate: GateItem): Decision | null {
  const raw = gate.auto_decision_reason;
  if (raw && DECISIONS.has(raw)) return raw as Decision;
  if (gate.status === 'pending') return 'ask_human';
  return null;
}

/** requires_human=true면 사람 액션 대상. 단 block은 읽기 전용(override=BE 정책 미정·열린항목④). */
export function gateNeedsAction(gate: GateItem): boolean {
  return gate.requires_human === true && gateDecision(gate) !== 'block';
}

function ciResult(gate: GateItem): 'pass' | 'fail' | null {
  const v = gate.neutral_facts?.['ci_result'];
  return v === 'pass' || v === 'fail' ? v : null;
}

function trustScore(gate: GateItem): number | null {
  const v = gate.neutral_facts?.['trust'];
  return typeof v === 'number' ? v : null; // null≠0 — 미측정 보존(AC③)
}

export function GateEvidence({ gate, className }: { gate: GateItem; className?: string }) {
  const t = useTranslations('cage');
  const decision = gateDecision(gate);
  const ci = ciResult(gate);
  const trust = trustScore(gate);
  const selfReportOnly = gate.neutral_facts?.['self_report_only'] === true;
  const reason = gate.decision_basis ?? gate.auto_decision_reason ?? null;
  // HO-S8 cold-start: 미확정 outcome은 "임시 예측"(keep/kill)으로만 — 판정/% 환원 절대 X.
  const coldStartSeed = gate.neutral_facts?.['cold_start_seed'] === true;
  const seedPrediction = gate.neutral_facts?.['seed_prediction'];
  const seedKey = seedPrediction === 'keep' ? 'seedKeep' : seedPrediction === 'kill' ? 'seedKill' : null;

  return (
    <div className={className}>
      {decision ? (
        <Badge variant={DECISION_META[decision].variant} className="shrink-0">
          <span aria-hidden className="mr-0.5">{DECISION_META[decision].mark}</span>
          {t(DECISION_META[decision].labelKey)}
        </Badge>
      ) : null}

      {/* HO-S8 AC①: CI(납품·"통과했다") ↔ Outcome(판단·"옳았다") 2열 분리 — "통과≠옳음" 명시. */}
      <div className="mt-1.5 grid grid-cols-1 gap-2 text-[11.5px] sm:grid-cols-2 sm:gap-3">
        {/* 좌: CI · 납품(delivery 신호 — 기계 검증). 신뢰도=clean_pass(delivery)·리뷰는 gate 미노출이라 제외. */}
        <div className="space-y-0.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{t('deliveryColLabel')}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
            <span>
              {t('ciLabel')}:{' '}
              {ci === 'pass' ? (
                <span className="text-success">✓ {t('ciPass')}</span>
              ) : ci === 'fail' ? (
                <span className="text-destructive">✗ {t('ciFail')}</span>
              ) : (
                <span>? {t('ciUnknown')}</span>
              )}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              {t('trustLabel')}:{' '}
              {trust === null ? (
                <span className="italic text-muted-foreground">{t('trustScoreNoData')}</span>
              ) : (
                <span className="text-foreground">{t('trustScorePercent', { score: Math.round(trust * 100) })}</span>
              )}
              {selfReportOnly ? (
                <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{t('selfReportTag')}</span>
              ) : null}
            </span>
          </div>
        </div>
        {/* 우: Outcome · 판단("옳았다 판정"). gate엔 정밀 hit_rate 없음 → 임시 예측 / 누적 중만(억지 % X·hit_rate %는 TrustScoreCard). */}
        <div className="space-y-0.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{t('outcomeColLabel')}</p>
          <div className="text-muted-foreground">
            {coldStartSeed ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="italic">{t('coldStartProvisional')}</span>
                {seedKey ? (
                  <Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>
                ) : null}
              </span>
            ) : (
              <span className="italic text-muted-foreground/80">{t('outcomeAccumulating')}</span>
            )}
          </div>
        </div>
      </div>

      {/* 사유 1줄(decision_basis·AC①②) */}
      {reason ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {t('reasonLabel')} · {reason}
        </p>
      ) : null}
    </div>
  );
}
