'use client';

import { Fragment, useEffect, useState } from 'react';
import { CheckCircle, XCircle, GitPullRequest, Check, Pause, Ban, Loader2, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
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

/**
 * auto_decision_reason(raw decision) 우선. 미상이면서 pending인 경우에만 ask_human으로
 * 통합하되, 그 통합은 requires_human===true일 때만 — 즉 "판정 결과가 사람 확인을 요구한다"는
 * 신호가 실제로 있을 때만 ask_human을 말한다.
 *
 * ⚠️story #2043 근본원인 fix: 이전엔 `status==='pending'`이면 requires_human 값과 무관하게
 * 무조건 ask_human을 리턴했다 — `POST /api/v2/gates` 직접 생성처럼 판정 알고리즘 자체를
 * 안 거쳐 requires_human이 기본값 false로 남은 게이트에서도 이 배지가 "Review needed"를
 * 말했다. 같은 화면 아래쪽(gates/[id]/page.tsx)은 requires_human 기준으로 "Auto-passed"를
 * 말해 한 화면이 서로 반대되는 두 문장을 동시에 말하는 자기모순이 났다(#2043 실측).
 * requires_human을 조건에 넣으면 "판정을 안 거친 껍데기 게이트"는 ask_human도 auto도 아닌
 * null(=판정 정보 없음)이 되어, 배지가 침묵하고 소비부(gates/[id]/page.tsx)가 그 침묵을
 * "판정 미거침"이라는 정직한 한 문장으로 대신 말한다 — 모순 대신 단일 문장.
 */
export function gateDecision(gate: GateItem): Decision | null {
  const raw = gate.auto_decision_reason;
  if (raw && DECISIONS.has(raw)) return raw as Decision;
  if (gate.status === 'pending' && gate.requires_human === true) return 'ask_human';
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
  // story #2814 — GitHub check 발행 자체도 "실 증거"다. 이게 유일한 신호인 게이트가 State A
  // (빈 카드)로 가라앉으면 안 된다 — State B/C 흐름에 자연히 합류시킨다.
  const hasGithubCheck = githubCheckState(gate) !== null;
  return hasCi || hasTrust || hasSeed || hasReason || hasGithubCheck;
}

type GithubCheckState = 'not_published' | 'in_progress' | 'success' | 'failure';

/**
 * story #2814(2813 BE 조각 착지분) — BE `_github_state_for_gate_status`와 정합(gate_github_check.py):
 * approved/auto_passed→success, rejected/voided→failure, pending/held→in_progress. 그 외 gate
 * status(discussed 등)는 GitHub check 관점에선 미정의라 null.
 *
 * ⚠️페드루군 AC 노트(PR#3244, 비차단) — 이 값은 gate.status에서 파생한 "게이트가 의도한" check
 * 상태이지, GitHub의 실제 check 상태를 조회한 값이 아니다. publish_gate_check()가 GitHub API
 * 호출에 실패하면 실제 check는 오래된 pending에 머무는데 이 화면은 approved→success로 보일 수
 * 있다 — GitHub 쪽은 fail-closed라 required check 미충족 시 머지가 막히므로 안전 사고는 아니고
 * 표시 정직성 문제만 있다. 실제 원장(gate_github_check_event) 조회로 좁히는 건 재-pending 사유
 * 표시(GithubRependingReason)가 맡는다.
 *
 * story #2814 2단(§5-④ 그라운딩·BE story #2815/PR#3245) — 관측모드 판별을 1단의 "run_id null이면
 * 무조건 숨김" 휴리스틱에서 `github_check_enforced`(단건 조회에서만 enrich) 기반으로 승격:
 *   - enforced===false(관측모드 확定) → run_id 유무·값과 무관하게 항상 숨김(가장 신뢰도 높은 신호).
 *   - enforced===true인데 run_id가 아직 null → "관측모드"가 아니라 "아직 발행 전"임을 이제는 안다
 *     — 1단엔 없던 not_published 상태로 승격 표시(숨기지 않음).
 *   - enforced===undefined/null(list_gates·inbox 등 미enrich 표면) → 1단 휴리스틱 그대로 폴백
 *     (run_id null=숨김) — 이 필드가 없는 표면에서 오판하지 않기 위한 안전망.
 */
export function githubCheckState(gate: GateItem): GithubCheckState | null {
  if (gate.github_check_enforced === false) return null;
  if (gate.github_check_run_id == null) {
    return gate.github_check_enforced === true ? 'not_published' : null;
  }
  switch (gate.status) {
    case 'approved':
    case 'auto_passed':
      return 'success';
    case 'rejected':
    case 'voided':
      return 'failure';
    case 'pending':
    case 'held':
      return 'in_progress';
    default:
      return null;
  }
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

// GitHub check 상태 — story #2814. null(발행 안 됨/관측모드)이면 호출 자체 안 함(다른 signal들과
// 동형 omit 규율). SHA는 짧은 표기(git 관례 7자)로, gate.status가 아니라 github_check_run_sha를
// 보여줘 "그 check-run이 실제로 겨냥한 SHA"를 그대로 노출한다(approved_head_sha는 승인이 귀속된
// SHA라는 다른 의미 — 재-pending 이후엔 이 둘이 갈릴 수 있어 혼용 금지).
function GithubCheckSignal({ state, sha }: { state: GithubCheckState; sha: string | null }) {
  const t = useTranslations('cage');
  const META: Record<GithubCheckState, { className: string; icon: LucideIcon; labelKey: string; spin?: boolean }> = {
    // story #2814 2단 — enforced===true인데 아직 발행 전(1단엔 없던 상태, githubCheckState 참조).
    not_published: { className: 'text-muted-foreground', icon: Pause, labelKey: 'githubCheckNotPublished' },
    in_progress: { className: 'text-muted-foreground', icon: Loader2, labelKey: 'githubCheckPending', spin: true },
    success: { className: 'text-success', icon: CheckCircle, labelKey: 'githubCheckSuccess' },
    failure: { className: 'text-destructive', icon: XCircle, labelKey: 'githubCheckFailure' },
  };
  const { className, icon: Icon, labelKey, spin } = META[state];
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Icon className={`size-3 shrink-0 ${spin ? 'animate-spin' : ''}`} aria-hidden />
      {t('githubCheckLabel')} {t(labelKey)}
      {sha ? <span className="font-mono text-muted-foreground">{t('githubCheckShaLabel', { sha: sha.slice(0, 7) })}</span> : null}
    </span>
  );
}

// story #2814 2단(§5-② 그라운딩) — backend/app/routers/gates.py GateGithubCheckEventResponse와 정합.
// story #2840(BE PR#3264 §2819) — prior_sha 추가. re_pending 행 전용(무효화된 승인이 귀속됐던
// SHA) — published/resolved 행이나 마이그레이션 이전 re_pending 행은 null(소급 불가).
interface GithubCheckLedgerEvent {
  id: string;
  repo_full_name: string;
  pr_number: number;
  head_sha: string;
  prior_sha: string | null;
  event_type: 'published' | 're_pending' | 'resolved';
  check_conclusion: string | null;
  created_at: string;
}

/**
 * 재-pending 사유 상세(story #2814 2단 AC②) — `GET /api/gates/{id}/github-check-events` 지연
 * 로드(최신순). 최신 이벤트가 `re_pending`이면 "새 커밋이 이전 승인을 무효화했다"는 문장을
 * 그 이벤트의 head_sha(무효화를 유발한 새 SHA)로 조립한다.
 *
 * story #2840(BE PR#3264 §2819 착지) — 원장에 `prior_sha`(무효화된 승인이 귀속됐던 SHA)가
 * 추가돼 "SHA {prior}에서 SHA {new}로 무효화" 완전 문구를 조립할 수 있다. `prior_sha`가
 * null인 행(published/resolved 행·마이그레이션 이전 re_pending 행)은 두 SHA를 지어내지
 * 않고 기존 단축 문구("새 커밋으로 이전 승인 무효화")로 정직하게 폴백한다(no-fiction).
 *
 * 트리거는 호출부(GateEvidence)가 결정 — ghState==='in_progress'일 때만 마운트한다(success/
 * failure/not_published/null인 게이트는 재-pending 여지 자체가 없어 호출 불요).
 *
 * ⚠️2026-08-20 라이브 AC2 재검 중 발견·즉시수정 — `events[0]`(최신 이벤트 그 자체)이 아니라
 * "가장 최근 re_pending 이벤트"를 찾아야 한다. 실왕복 확인 결과 새 커밋 감지 시 BE가 re_pending
 * 기록 직후(같은 웹훅 처리 안에서) 그 새 SHA로 새 check-run을 published — 즉 정상 케이스에서
 * `events[0]`은 거의 항상 `published`이고 `re_pending`은 events[1]. 이전 코드(`events[0]?.event_type
 * !== 're_pending'`)는 이 실측 순서에서 사실상 절대 참이 안 돼 사유 문구가 죽어있었다(AC2 미충족).
 * ghState==='in_progress' 마운트 가드가 이미 "아직 미해결"을 보장하므로, 원장에서 가장 최근
 * re_pending을 찾아 그 SHA로 표시하면 된다(뒤이은 published가 있어도 그 사유는 여전히 유효).
 *
 * 실패/빈 응답은 침묵(옵션 정보라 카드 붕괴 X) — 이 신호가 evidence 판정(gateHasEvidence)에
 * 관여하지 않는 이유이기도 하다(로드 전/실패 시에도 카드가 이미 유효한 GithubCheckSignal로
 * State B/C에 들어가 있어야 함).
 */
function GithubRependingReason({ gateId }: { gateId: string }) {
  const t = useTranslations('cage');
  const [repending, setRepending] = useState<GithubCheckLedgerEvent | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/gates/${gateId}/github-check-events`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((events: GithubCheckLedgerEvent[]) => {
        if (!cancelled) setRepending(events.find((e) => e.event_type === 're_pending') ?? null);
      })
      .catch(() => {
        if (!cancelled) setRepending(null);
      });
    return () => { cancelled = true; };
  }, [gateId]);

  if (!repending) return null;

  return (
    <p className="mt-1 text-[11px] text-muted-foreground">
      {repending.prior_sha
        ? t('githubCheckRependingReasonWithPrior', { priorSha: repending.prior_sha.slice(0, 7), newSha: repending.head_sha.slice(0, 7) })
        : t('githubCheckRependingReason', { newSha: repending.head_sha.slice(0, 7) })}
    </p>
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
  const ghState = githubCheckState(gate);
  const ghSha = gate.github_check_run_sha ?? null;
  // story #2814 2단 AC② — 재-pending 이력이 있을 수 있는 상태(in_progress)에서만 원장을 지연 조회.
  const showRepending = ghState === 'in_progress';
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
        <p className="mt-1.5 text-[11.5px] italic text-muted-foreground">{t('evidenceNonePrompt')}</p>
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
            <p className="text-[10px] font-medium text-muted-foreground">{t('deliveryColLabel')}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              {ci !== null ? <CiSignal ci={ci} /> : null}
              {trust !== null ? <TrustValue trust={trust} selfReportOnly={selfReportOnly} /> : null}
              {ghState !== null ? <GithubCheckSignal state={ghState} sha={ghSha} /> : null}
              {/* Bot-L.2: 연결 PR(read-only·관리는 story 상세). 없으면 omit. AC·위험 슬롯은 후속. */}
              {prLinks.map((p, i) => <GatePrChip key={`${p.repo_full_name}#${p.pr_number}-${i}`} pr={p} />)}
            </div>
          </div>
          {/* 우: 판단("옳았다 판정"). gate엔 정밀 hit_rate 없음 → 임시 예측만(억지 % X). */}
          <div className="space-y-0.5">
            <p className="text-[10px] font-medium text-muted-foreground">{t('outcomeColLabel')}</p>
            <div className="text-muted-foreground">
              {seedKey ? (
                <Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>
              ) : (
                <span className="italic text-muted-foreground">{t('coldStartProvisional')}</span>
              )}
            </div>
          </div>
        </div>
        {showRepending ? <GithubRependingReason gateId={gate.id} /> : null}
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
  if (ghState !== null) facts.push(<GithubCheckSignal state={ghState} sha={ghSha} />);
  if (coldStartSeed && seedKey) facts.push(<Badge variant="chip" className="shrink-0">{t(seedKey)}</Badge>);

  return (
    <div className={className}>
      {decisionBadge}
      {facts.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
          {facts.map((node, i) => (
            <Fragment key={i}>
              {i > 0 ? <span aria-hidden className="text-muted-foreground">·</span> : null}
              {node}
            </Fragment>
          ))}
        </div>
      ) : null}
      {showRepending ? <GithubRependingReason gateId={gate.id} /> : null}
      {reason ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t('reasonLabel')} · {reason}</p>
      ) : null}
    </div>
  );
}
