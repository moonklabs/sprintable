'use client';

import { startTransition, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/shared/avatar';
import { Proofline, type ProofState } from './proofline';
import { TrustSeal, type TrustSealClaimedProps, type TrustSealVerifiedProps } from '@/components/verify/trust-seal';

export type { ProofState } from './proofline';

export interface ProofCapsuleHuman {
  name: string;
  role: string;
}

export interface ProofCapsuleAgent {
  name: string;
  initial: string;
}

export interface ProofCapsuleEvidence {
  /** AC 충족 카운트 — per-AC 구조가 있는 소스에서만(freeform AC는 카운트=fiction). 둘 다 있을 때만 렌더. */
  acMet?: number;
  acTotal?: number;
  autoVerify?: 'passed' | 'failed' | null;
  diff?: { add: number; del: number };
  proofCount?: number;
}

export interface ProofCapsuleGate {
  /** full 밀도(Human gate)만 사용 — Attention Queue의 row 밀도는 위험도 표시가 없어 생략 가능.
   * 값 자체는 canonical(비-i18n) 식별자 — 표시 시점에 `proofCapsule.risk.*` 로 번역(§RISK_KEY). */
  risk?: '낮음' | '보통' | '높음';
  action: string;
  href?: string;
  /** row 밀도(Attention Queue 재사용)에서 개입유형별 버튼 톤 분기. 기본 primary(기존
   * Full/Row 호출부 무변경) — neutral=중립 outline(재작업/조율 등)·ready=Green solid(병합 대기). */
  tone?: 'primary' | 'neutral' | 'ready';
}

export type ProofCapsuleDensity = 'full' | 'card' | 'row' | 'audit';

export interface ProofCapsuleProps {
  proofState: ProofState;
  stateLabel: string;
  claim: string;
  /** row 밀도 전용(story #2249, Attention Queue) — 「그 상태에 들어간 지 얼마나 됐는지」를 호출부가
   * 미리 포맷해 넘긴다(예: "3일 전"). 모르면 아예 넘기지 않는다(빈 문자열/"모름" 라벨로 지어내지
   * 않음 — glance.py의 entered_state_at이 null인 신호는 값 자체가 없다). */
  duration?: string;
  /** row 밀도 전용(story #2923 AQ2, doc attention-audit-redesign-2923) — 「지금 개입할 것」의
   * 개입 유형(예: GATE/STEER/BLOCK/Q) compact 배지. Yuna AQ2 확定(2026-08-22): 「색은 신뢰상태
   * 축 하나(레일/점)뿐」 — 이 배지는 무채(monochrome)로만 렌더한다(색 이중 인코딩 금지). 값은
   * 호출부가 이미 계산해 넘긴다(feature-agnostic 컴포넌트가 특정 도메인의 버킷 열거형을 몰라도
   * 되게 plain string으로 받는다 — AttentionQueueItem.bucket 등). */
  typeBadge?: string;
  /** full/audit만 사용 — card/row는 다중 담당자(예: Board card의 assignee 스택)를 자체
   * 렌더하는 경우가 많아 요구하지 않는다(optional, 2026-07-11 Board 확산 시 완화). */
  human?: ProofCapsuleHuman;
  agent?: ProofCapsuleAgent;
  now?: string;
  evidence?: ProofCapsuleEvidence;
  gate?: ProofCapsuleGate;
  /** full 밀도 전용(claimed-vs-verified-spec-handoff) — "누가 증언하나"의 2주어 분화 스트립.
   * 시각 스캐폴딩: 실 데이터(self_reported/human_verified)는 BE 계약 확정 후 배선, 지금은
   * 타입·렌더만 준비(호출부 없음 무방 — density="full"와 동일 선례). */
  trustSeal?: TrustSealClaimedProps | TrustSealVerifiedProps;
  density: ProofCapsuleDensity;
  /** card·full 밀도 — claim/evidence 아래 호출부 컨텐츠(예: Board card의 담당자 스택·배지,
   * /gates/[id] 상세의 org/project 컨텍스트·상태별 액션 분기·EntityBacklinksSection) 삽입
   * 슬롯. Proof Capsule 자체 필드로 표현 안 되는 실 기능을 안 잃게(story #2926 P0-F F2 —
   * full 밀도의 GateRow는 단일 버튼 추상이라 gates/[id]의 다상태 액션 분기를 못 담아
   * footer로 이관). */
  footer?: ReactNode;
  /** story #2926(P0-F F1) — card 밀도 전용. claim 자체가 상세/미리보기 진입점인 호출부(예:
   * 챗 ApprovalRequestCard의 doc/story 제목 클릭→EntityPreviewModal)를 위한 훅. 있으면 claim이
   * `<button>`(hover underline)으로, 없으면 기존과 동일한 순수 텍스트로 렌더된다 — 기존
   * card 호출부(Board story-card.tsx 등)는 전부 무변화. */
  onClaimClick?: () => void;
  className?: string;
}

/**
 * Proof Capsule — Sprintable 시그니처 공용어(proof-capsule-fe-spec-handoff). "감시 아니라
 * 신뢰": 활동/로그 아니라 약속(Claim)·증거(Evidence)·인간 게이트(Human gate)가 주어. 카드·
 * Inbox·Story 상세·Audit 전면에서 밀도(density)만 달리해 재사용되는 공용어.
 *
 * 도크트린 5 준수: ①약속>활동(claim이 항상 최상단) ②주장>로그(활동 로그·raw CoT 필드 자체가
 * 없음) ③예외 선명(red/amber 숨기지 않음) ④자동화 경계(agent는 항상 human과 구분된 마커)
 * ⑤인간=책임 주체(Human gate가 항상 마지막 결정점). 안티패턴 0: sparkle·rainbow·유리카드·
 * glow·999px pill·숫자 KPI화·raw CoT·초록만-완료 전부 미사용(색은 항상 stateLabel 텍스트 병기).
 */
export function ProofCapsule({
  proofState, stateLabel, claim, human, agent, now, evidence, gate, trustSeal, density, footer, className, duration, onClaimClick, typeBadge,
}: ProofCapsuleProps) {
  if (density === 'audit') {
    return (
      <AuditRow proofState={proofState} claim={claim} now={now} human={human} agent={agent} className={className} />
    );
  }
  if (density === 'row') {
    return (
      <InlineRow
        proofState={proofState} stateLabel={stateLabel} claim={claim} human={human} agent={agent}
        gate={gate} duration={duration} className={className} typeBadge={typeBadge}
      />
    );
  }
  if (density === 'card') {
    return (
      <CardVariant proofState={proofState} stateLabel={stateLabel} claim={claim} evidence={evidence} footer={footer} className={className} onClaimClick={onClaimClick} />
    );
  }
  return (
    <FullVariant
      proofState={proofState} stateLabel={stateLabel} claim={claim} human={human} agent={agent}
      now={now} evidence={evidence} gate={gate} trustSeal={trustSeal} className={className} footer={footer}
    />
  );
}

function CutCornerShell({ state, cut, className, children }: { state: ProofState; cut: number; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn('flex overflow-hidden rounded-[6px] border border-proof-line bg-proof-panel', className)}
      style={{ clipPath: `polygon(0 0, calc(100% - ${cut}px) 0, 100% ${cut}px, 100% 100%, 0 100%)` }}
    >
      <Proofline state={state} />
      {children}
    </div>
  );
}

function StateHeader({ state, label }: { state: ProofState; label: string }) {
  const tone: Record<ProofState, string> = {
    blue: 'text-proof-blue', amber: 'text-proof-amber', green: 'text-proof-green', red: 'text-proof-red',
  };
  const dotTone: Record<ProofState, string> = {
    blue: 'bg-proof-blue', amber: 'bg-proof-amber', green: 'bg-proof-green', red: 'bg-proof-red',
  };
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', tone[state])}>
      <span className={cn('size-1.5 rounded-full', dotTone[state])} aria-hidden="true" />
      {label}
    </span>
  );
}

/** canonical(비-i18n) risk 식별자 → `proofCapsule.risk.*` 번역키. */
const RISK_KEY: Record<NonNullable<ProofCapsuleGate['risk']>, 'low' | 'medium' | 'high'> = {
  '낮음': 'low', '보통': 'medium', '높음': 'high',
};

function EvidenceRow({ evidence, sweep }: { evidence: ProofCapsuleEvidence; sweep: boolean }) {
  const t = useTranslations('proofCapsule');
  return (
    <div className="relative mt-3.5 border-t border-proof-line-soft pt-3">
      {sweep ? (
        <div
          className="motion-safe:animate-proof-sweep pointer-events-none absolute inset-x-0 top-0 h-full bg-gradient-to-b from-proof-citron/25 to-transparent"
          aria-hidden="true"
        />
      ) : null}
      <div className="mb-2 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint">
        {t('evidence.label')}
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-[13px] leading-[1.45] text-proof-ink-2">
        {evidence.acMet != null && evidence.acTotal != null ? (
          <span className="inline-flex items-center gap-1">
            <Check className="motion-safe:animate-proof-check-in size-3.5 text-proof-green" strokeWidth={3} aria-hidden="true" />
            {t('evidence.acMet', { met: evidence.acMet, total: evidence.acTotal })}
          </span>
        ) : null}
        {evidence.autoVerify === 'passed' ? (
          <span className="inline-flex items-center gap-1">
            <Check className="motion-safe:animate-proof-check-in size-3.5 text-proof-green" strokeWidth={3} aria-hidden="true" />
            {t('evidence.autoPassed')}
          </span>
        ) : null}
        {evidence.autoVerify === 'failed' ? (
          <span className="text-proof-red">{t('evidence.autoFailed')}</span>
        ) : null}
        {evidence.diff ? (
          <span className="font-mono text-[11px] text-proof-ink-3">diff +{evidence.diff.add} / −{evidence.diff.del}</span>
        ) : null}
      </div>
      {evidence.proofCount != null ? (
        <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-proof-ink-3">
          <ChevronDown className="size-3" aria-hidden="true" />
          {t('evidence.count', { count: evidence.proofCount })}
        </div>
      ) : null}
    </div>
  );
}

function GateRow({ gate, human }: { gate: ProofCapsuleGate; human: ProofCapsuleHuman }) {
  const t = useTranslations('proofCapsule');
  return (
    <div className="mt-3.5 border-t border-proof-line-soft pt-3">
      <div className="mb-2 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint">
        {t('gate.label')}
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-[13px] text-proof-ink-2">
        <span>{t.rich('gate.owner', { name: human.name, b: (chunks) => <b className="text-proof-ink">{chunks}</b> })}</span>
        {gate.risk ? (
          <span className="font-mono text-[10.5px]">{t('gate.risk', { risk: t(`risk.${RISK_KEY[gate.risk]}`) })}</span>
        ) : null}
        <a
          href={gate.href}
          className="ml-auto inline-flex items-center gap-1 rounded-[6px] border border-proof-blue bg-proof-blue-soft px-3 py-1 text-[11.5px] font-semibold text-proof-blue transition-colors duration-[140ms] hover:bg-proof-blue hover:text-white"
        >
          {gate.action}
          <ArrowRight className="size-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

function useEvidenceSweep(evidence: ProofCapsuleEvidence | undefined) {
  const [sweep, setSweep] = useState(false);
  const prevKey = useRef<string | null>(null);
  useEffect(() => {
    if (!evidence) return;
    const key = JSON.stringify(evidence);
    const changed = prevKey.current !== null && prevKey.current !== key;
    prevKey.current = key;
    if (!changed) return;
    startTransition(() => setSweep(true));
    const t = setTimeout(() => startTransition(() => setSweep(false)), 650);
    return () => clearTimeout(t);
  }, [evidence]);
  return sweep;
}

function FullVariant({
  proofState, stateLabel, claim, human, agent, now, evidence, gate, trustSeal, className, footer,
}: Omit<ProofCapsuleProps, 'density'>) {
  const t = useTranslations('proofCapsule');
  const sweep = useEvidenceSweep(evidence);
  return (
    <CutCornerShell state={proofState} cut={24} className={className}>
      <div className="min-w-0 flex-1 px-4.5 py-4">
        <StateHeader state={proofState} label={stateLabel} />
        <div className="mb-1 mt-3 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint">
          {t('claim.label')}
        </div>
        <div className="text-[19px] font-bold leading-[1.25] tracking-[-0.012em] text-proof-ink">{claim}</div>
        <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-proof-ink-3">
          {human ? (
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={human.name} actorType="human" size={19} />
              {t.rich('gate.owner', { name: human.name, b: (chunks) => <>{chunks}</> })}
            </span>
          ) : null}
          {agent ? (
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={agent.name} actorType="agent" size={19} />
              {t('claim.executor', { name: agent.name })}
            </span>
          ) : null}
          {now ? <span className="text-proof-ink-2">{t.rich('claim.now', { now, b: (chunks) => <b>{chunks}</b> })}</span> : null}
          {proofState === 'blue' ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] text-proof-ink-3">
              <span className="motion-safe:animate-proof-pulse size-1.5 rounded-full bg-proof-citron" aria-hidden="true" />
              {t('claim.running')}
            </span>
          ) : null}
        </div>
        {evidence ? <EvidenceRow evidence={evidence} sweep={sweep} /> : null}
        {/* claimed-vs-verified-spec-handoff §2 — "누가 증언하나"의 2주어 분화. 없으면 생략(무증거=
            무표시, no-fiction). Human gate(pending 결재)와 별개 관심사라 GateRow와 공존 가능. */}
        {trustSeal ? (
          <div className="mt-3.5 border-t border-proof-line-soft pt-3">
            <TrustSeal {...trustSeal} />
          </div>
        ) : null}
        {/* Human gate는 도크트린⑤(인간=책임 주체)상 책임자 없이 못 열림 — human 없으면 생략. */}
        {gate && human ? <GateRow gate={gate} human={human} /> : null}
        {footer}
      </div>
    </CutCornerShell>
  );
}

function CardVariant({ proofState, stateLabel, claim, evidence, footer, className, onClaimClick }: Pick<ProofCapsuleProps, 'proofState' | 'stateLabel' | 'claim' | 'evidence' | 'footer' | 'className' | 'onClaimClick'>) {
  return (
    <CutCornerShell state={proofState} cut={16} className={cn('w-full max-w-[280px]', className)}>
      <div className="min-w-0 flex-1 px-3 py-2.5">
        <StateHeader state={proofState} label={stateLabel} />
        {onClaimClick ? (
          <button
            type="button"
            onClick={onClaimClick}
            className="mt-1.5 line-clamp-2 w-full text-left text-[12.5px] font-semibold leading-snug text-proof-ink hover:underline"
          >
            {claim}
          </button>
        ) : (
          <div className="mt-1.5 line-clamp-2 text-[12.5px] font-semibold leading-snug text-proof-ink">{claim}</div>
        )}
        {evidence ? (
          <div className="mt-1.5 flex items-center gap-2.5 text-[10.5px] text-proof-ink-3">
            {evidence.acMet != null && evidence.acTotal != null ? (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3 text-proof-green" strokeWidth={3} aria-hidden="true" />
                {evidence.acMet}/{evidence.acTotal}
              </span>
            ) : null}
            {evidence.diff ? <span className="font-mono">+{evidence.diff.add}</span> : null}
          </div>
        ) : null}
        {footer}
      </div>
    </CutCornerShell>
  );
}

const GATE_BUTTON_TONE: Record<NonNullable<ProofCapsuleGate['tone']>, string> = {
  primary: 'border-proof-blue bg-proof-blue-soft text-proof-blue hover:bg-proof-blue hover:text-white',
  neutral: 'border-proof-line text-proof-ink-2 hover:bg-proof-sunk',
  ready: 'border-proof-green bg-proof-green-soft text-proof-green hover:bg-proof-green hover:text-white',
};

function InlineRow({
  proofState, stateLabel, claim, human, agent, gate, duration, className, typeBadge,
}: Pick<ProofCapsuleProps, 'proofState' | 'stateLabel' | 'claim' | 'human' | 'agent' | 'gate' | 'duration' | 'className' | 'typeBadge'>) {
  return (
    <CutCornerShell state={proofState} cut={16} className={cn('w-full', className)}>
      <div className="flex min-h-[52px] min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
        <span className="flex shrink-0 items-center gap-1.5">
          {/* story #2923 AQ2(Yuna 확定 2026-08-22) — 개입유형(GATE/STEER/BLOCK/Q) compact
              배지. 「색은 신뢰상태 축 하나(레일/점+아래 StateHeader)뿐」 — 이 배지는 무채
              (bg-proof-sunk·text-proof-ink-2, 색 없음)로만 렌더한다. StateHeader는 그대로
              둔다(proofState의 문자 신호 유지 — 도크트린 "색만으로 의미 전달 금지"가 요구하는
              stateLabel 텍스트 병기를 이 배지 추가로 잃지 않는다). */}
          {typeBadge ? (
            // 유나 비차단 refinement(2026-08-22, PR#3356) — GATE/STEER/BLOCK/Q 글자수 편차
            // (1~5자)로 auto-width면 claim 좌측 정렬이 들쭉날쭉했다. min-w로 폭 통일(최장
            // 라벨 STEER 기준)+text-center로 짧은 라벨(Q)도 같은 자리에 정렬.
            <span className="min-w-[30px] rounded-[4px] border border-proof-line bg-proof-sunk px-1.5 py-0.5 text-center text-[8px] font-bold uppercase tracking-[0.04em] text-proof-ink-2">
              {typeBadge}
            </span>
          ) : null}
          <StateHeader state={proofState} label={stateLabel} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-proof-ink">{claim}</span>
        <span className="inline-flex shrink-0 items-center gap-2">
          {duration ? <span className="shrink-0 text-[10.5px] font-medium text-proof-ink-3">{duration}</span> : null}
          {human ? <Avatar name={human.name} actorType="human" size={22} /> : null}
          {agent ? <Avatar name={agent.name} actorType="agent" size={22} /> : null}
          {gate ? (
            <a
              href={gate.href}
              className={cn(
                'rounded-[8px] border px-2.5 py-1 text-[10.5px] font-semibold transition-colors duration-[140ms]',
                GATE_BUTTON_TONE[gate.tone ?? 'primary'],
              )}
            >
              {gate.action}
            </a>
          ) : null}
        </span>
      </div>
    </CutCornerShell>
  );
}

// story #2923(P0-E AQ4, 2926-08-22 그라운딩 발견) — 시안(attention-audit-redesign-2923)이
// audit density에 "아바타 shape로 human/agent 구분"을 명시했는데, 이 행은 그동안 human?.name을
// mono 텍스트로만 붙일 뿐 아바타 자체를 전혀 안 그렸고(agent prop은 애초에 dispatch에서도
// 안 넘어옴 — 위 ProofCapsule 본체 참고) human/agent 구분 신호가 텍스트 role 문자열 하나뿐이라
// 도크트린④(자동화 경계, 항상 구분된 마커)를 audit density만 못 채우고 있었다. 공유 Avatar를
// size=16(시안 .av 16px 그대로)으로 재사용 — 신규 아바타 컴포넌트 0.
function AuditRow({ proofState, claim, now, human, agent, className }: Pick<ProofCapsuleProps, 'proofState' | 'claim' | 'now' | 'human' | 'agent' | 'className'>) {
  const dotTone: Record<ProofState, string> = {
    blue: 'bg-proof-blue', amber: 'bg-proof-amber', green: 'bg-proof-green', red: 'bg-proof-red',
  };
  const actorName = agent?.name ?? human?.name;
  return (
    <div className={cn('flex items-center gap-2 rounded-[6px] border border-proof-line bg-proof-panel px-3 py-2 text-[11px]', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', dotTone[proofState])} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-proof-ink">{claim}</span>
      {actorName ? <Avatar name={actorName} actorType={agent ? 'agent' : 'human'} size={16} /> : null}
      <span className="shrink-0 font-mono text-[9.5px] text-proof-faint">{[now, actorName].filter(Boolean).join(' ')}</span>
    </div>
  );
}
