'use client';

import { Fragment } from 'react';
import { CheckCircle, XCircle, GitPullRequest, Check, Pause, Ban, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { GateItem } from '@/components/kanban/types';

/**
 * H1-S8 머지 verdict 게이트 evidence(read-only 표시). 3 surface(GateInbox row·story detail·
 * approve/reject facts) 공용. 신규 화면 0 — decision 배지 + facts(CI·신뢰도) + 사유.
 *
 * 🔑 핵심 가드(AC③): 신뢰도 None=`null`은 "데이터 없음"으로만 표시한다. 0%/빨강/낮음으로
 * 절대 환원하지 않는다(null≠0 — 미측정과 0은 다르다). CI 미상도 동형(미표시).
 * 플랫폼은 위험도 판단을 하지 않는다(neutral_facts = 관찰 사실).
 *
 * 🔑 S3 상태 위계(E-DG-REAL): "없으면 비운다(omit, not placeholder)". 데이터 없는 카드는
 * 2열 그리드·"없음" 라벨을 렌더하지 않고 한 줄로 가라앉힌다(recede). 세 시각 결과 —
 *   A 빈/증거-없음(`!gateHasEvidence`): decision 배지 + 한 줄 안내만.
 *   B 부분증거: present-fact만 flowing 1줄(없는 건 빠짐·dangling `·` 금지) + 사유.
 *   C 충실((ci||trust) && coldStartSeed): 납품|판단 2열 복귀(HO-S8 "통과≠옳음" 보존·S5 슬롯).
 *
 * decision 배지 3종(BE decision = auto_merge|ask_human|block). gate status=pending(미transition)은
 * ask_human "확인 필요"로 통합(정합 노트 — 별도 "대기" 배지 불필요). 리뷰 증거는 gate 응답에
 * 미노출이라 v1 제외(억지 "없음"=오정보·follow-up). evidence_status는 배지 X·맥락 보조만.
 */

type Decision = 'auto_merge' | 'ask_human' | 'block';

/** E-GHAPP Bot-L.2: gate 카드 read-only PR 칩(forward-compat — BE가 neutral_facts.pr_links 채우면 렌더). */
interface PrLinkFact {
  repo_full_name: string;
  pr_number: number;
  link_source?: string; // 'explicit' | 'auto' | 'sid'
}

const DECISION_META: Record<Decision, { variant: 'success' | 'warning' | 'destructive'; mark: LucideIcon; labelKey: string }> = {
  auto_merge: { variant: 'success', mark: Check, labelKey: 'decisionAutoMerge' },
  ask_human: { variant: 'warning', mark: Pause, labelKey: 'decisionAskHuman' },
  block: { variant: 'destructive', mark: Ban, labelKey: 'decisionBlock' },
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

/**
 * 카드에 사람이 평가할 '실 증거'가 있는가. 빈/cold-start 구분의 단일 소스.
 * self_report_only 단독은 증거 아님(trust 실값에 붙는 qualifier로만 — 빈카드 도배 원인 제거).
 */
export function gateHasEvidence(gate: GateItem): boolean {
  const f = gate.neutral_facts;
  const hasCi = f?.['ci_result'] === 'pass' || f?.['ci_result'] === 'fail';
  const hasTrust = typeof f?.['trust'] === 'number'; // null≠0 — number만
  const hasSeed = f?.['cold_start_seed'] === true;
  const hasReason = Boolean(gate.decision_basis); // 실 human reason만
  return hasCi || hasTrust || hasSeed || hasReason;
}

// CI 신호 — lucide CheckCircle/XCircle(gate-line-context 정합·boy-scout). null이면 호출 자체 안 함(omit).
function CiSignal({ ci }: { ci: 'pass' | 'fail' }) {
  const t = useTranslations('cage');
  return ci === 'pass' ? (
    <span className="inline-flex items-center gap-1 text-success">
      <CheckCircle className="size-3 shrink-0" />
      {t('ciLabel')} {t('ciPass')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-destructive">
      <XCircle className="size-3 shrink-0" />
      {t('ciLabel')} {t('ciFail')}
    </span>
  );
}

// 신뢰도 — 실값만. 자기보고 태그는 trust 실값에 '붙어서만'(단독 도배 금지).
function TrustValue({ trust, selfReportOnly }: { trust: number; selfReportOnly: boolean }) {
  const t = useTranslations('cage');
  return (
    <span className="inline-flex items-center gap-1">
      {t('trustLabel')}{' '}
      <span className="text-foreground">{t('trustScorePercent', { score: Math.round(trust * 100) })}</span>
      {selfReportOnly ? (
        <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{t('selfReportTag')}</span>
      ) : null}
    </span>
  );
}

// read-only PR 칩(gate State C 납품 컬럼). 관리는 story 상세 PrLinkSection — 여기선 표시·새탭 링크만.
function GatePrChip({ pr }: { pr: PrLinkFact }) {
  return (
    <a
      href={`https://github.com/${pr.repo_full_name}/pull/${pr.pr_number}`}
      target="_blank"
      rel="noopener noreferrer"
      title={pr.repo_full_name}
      className="inline-flex max-w-full items-center"
    >
      <Badge variant={pr.link_source === 'explicit' ? 'default' : 'outline'} className="shrink-0 gap-1 hover:underline">
        <GitPullRequest className="size-3 shrink-0" />#{pr.pr_number}
      </Badge>
    </a>
  );
}

export function GateEvidence({ gate, className }: { gate: GateItem; className?: string }) {
  const t = useTranslations('cage');
  const decision = gateDecision(gate);
  const ci = ciResult(gate);
  const trust = trustScore(gate);
  const selfReportOnly = gate.neutral_facts?.['self_report_only'] === true;
  const reason = gate.decision_basis ?? null; // 실 human reason만(auto_decision_reason echo 폴백 제거 — 배지가 이미 표시)
  // HO-S8 cold-start: 미확정 outcome은 "임시 예측"(keep/kill)으로만 — 판정/% 환원 절대 X.
  const coldStartSeed = gate.neutral_facts?.['cold_start_seed'] === true;
  const seedPrediction = gate.neutral_facts?.['seed_prediction'];
  const seedKey = seedPrediction === 'keep' ? 'seedKeep' : seedPrediction === 'kill' ? 'seedKill' : null;
  // E-GHAPP Bot-L.2: 연결 PR(read-only). BE가 neutral_facts.pr_links 채우면 렌더·없으면 omit(S3 원칙).
  const prLinks = Array.isArray(gate.neutral_facts?.['pr_links'])
    ? (gate.neutral_facts!['pr_links'] as PrLinkFact[]).filter((p) => p?.repo_full_name && typeof p?.pr_number === 'number')
    : [];

  const DecisionMark = decision ? DECISION_META[decision].mark : null;
  const decisionBadge = decision ? (
    <Badge variant={DECISION_META[decision].variant} className="shrink-0 gap-0.5">
      {DecisionMark ? <DecisionMark aria-hidden className="size-3" /> : null}
      {t(DECISION_META[decision].labelKey)}
    </Badge>
  ) : null;

  // ── State A · 빈 / 증거-없음: 배지 + 한 줄만(2열·CI·신뢰도·outcome·자기보고 전부 미표시·recede)
  if (!gateHasEvidence(gate)) {
    return (
      <div className={className}>
        {decisionBadge}
        <p className="mt-1.5 text-[11.5px] italic text-muted-foreground/60">{t('evidenceNonePrompt')}</p>
      </div>
    );
  }

  // ── State C · 실증거 충실: 납품 신호 AND 판단 신호 둘 다 → 납품|판단 2열 복귀(forward-compat·S5 슬롯)
  const rich = (ci !== null || trust !== null) && coldStartSeed;
  if (rich) {
    return (
      <div className={className}>
        {decisionBadge}
        {/* HO-S8 AC①: CI(납품·"통과했다") ↔ Outcome(판단·"옳았다") 2열 분리 — "통과≠옳음" 명시. */}
        <div className="mt-1.5 grid grid-cols-1 gap-2 text-[11.5px] sm:grid-cols-2 sm:gap-3">
          {/* 좌: 납품(delivery 신호 — 기계 검증). S5(GitHub앱) PR·AC·위험 슬롯 자리. */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70">{t('deliveryColLabel')}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              {ci !== null ? <CiSignal ci={ci} /> : null}
              {trust !== null ? <TrustValue trust={trust} selfReportOnly={selfReportOnly} /> : null}
              {/* Bot-L.2: 연결 PR(read-only·관리는 story 상세). 없으면 omit. AC·위험 슬롯은 후속. */}
              {prLinks.map((p, i) => <GatePrChip key={`${p.repo_full_name}#${p.pr_number}-${i}`} pr={p} />)}
            </div>
          </div>
          {/* 우: 판단("옳았다 판정"). gate엔 정밀 hit_rate 없음 → 임시 예측만(억지 % X). */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium text-muted-foreground/70">{t('outcomeColLabel')}</p>
            <div className="text-muted-foreground">
              {seedKey ? (
                <Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>
              ) : (
                <span className="italic text-muted-foreground/80">{t('coldStartProvisional')}</span>
              )}
            </div>
          </div>
        </div>
        {reason ? (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t('reasonLabel')} · {reason}</p>
        ) : null}
      </div>
    );
  }

  // ── State B · 부분증거: present-fact만 flowing 1줄(없는 건 빠짐·구분자 `·`는 양옆 항목 있을 때만)
  const facts: React.ReactNode[] = [];
  if (ci !== null) facts.push(<CiSignal ci={ci} />);
  if (trust !== null) facts.push(<TrustValue trust={trust} selfReportOnly={selfReportOnly} />);
  if (coldStartSeed && seedKey) facts.push(<Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>);

  return (
    <div className={className}>
      {decisionBadge}
      {facts.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
          {facts.map((node, i) => (
            <Fragment key={i}>
              {i > 0 ? <span aria-hidden className="text-muted-foreground/50">·</span> : null}
              {node}
            </Fragment>
          ))}
        </div>
      ) : null}
      {reason ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t('reasonLabel')} · {reason}</p>
      ) : null}
    </div>
  );
}
