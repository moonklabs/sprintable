'use client';

import { startTransition, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/storage/format';
import { Proofline, type ProofState } from './proofline';

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
  acMet: number;
  acTotal: number;
  autoVerify?: 'passed' | 'failed' | null;
  diff?: { add: number; del: number };
  proofCount?: number;
}

export interface ProofCapsuleGate {
  risk: '낮음' | '보통' | '높음';
  action: string;
  href?: string;
}

export type ProofCapsuleDensity = 'full' | 'card' | 'row' | 'audit';

export interface ProofCapsuleProps {
  proofState: ProofState;
  stateLabel: string;
  claim: string;
  /** full/audit만 사용 — card/row는 다중 담당자(예: Board card의 assignee 스택)를 자체
   * 렌더하는 경우가 많아 요구하지 않는다(optional, 2026-07-11 Board 확산 시 완화). */
  human?: ProofCapsuleHuman;
  agent?: ProofCapsuleAgent;
  now?: string;
  evidence?: ProofCapsuleEvidence;
  gate?: ProofCapsuleGate;
  density: ProofCapsuleDensity;
  /** card 밀도 전용 — claim/evidence 아래 호출부 컨텐츠(예: Board card의 담당자 스택·배지·
   * 컨텍스트 메뉴 앵커) 삽입 슬롯. Proof Capsule 자체 필드로 표현 안 되는 실 기능을 안 잃게. */
  footer?: ReactNode;
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
  proofState, stateLabel, claim, human, agent, now, evidence, gate, density, footer, className,
}: ProofCapsuleProps) {
  if (density === 'audit') {
    return (
      <AuditRow proofState={proofState} claim={claim} now={now} human={human} className={className} />
    );
  }
  if (density === 'row') {
    return (
      <InlineRow proofState={proofState} stateLabel={stateLabel} claim={claim} gate={gate} className={className} />
    );
  }
  if (density === 'card') {
    return (
      <CardVariant proofState={proofState} stateLabel={stateLabel} claim={claim} evidence={evidence} footer={footer} className={className} />
    );
  }
  return (
    <FullVariant
      proofState={proofState} stateLabel={stateLabel} claim={claim} human={human} agent={agent}
      now={now} evidence={evidence} gate={gate} className={className}
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

/** Workcell 등 다른 Proof Capsule 계열 컴포넌트가 동일 아바타 스타일을 재사용할 수 있게 export. */
export function ProofAvatar({ label, isAgent, size = 19 }: { label: string; isAgent?: boolean; size?: number }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold',
        isAgent
          ? 'border-proof-blue bg-proof-blue-soft text-proof-blue'
          : 'border-proof-line bg-proof-sunk text-proof-ink-2',
      )}
      style={{ width: size, height: size }}
    >
      {label}
    </span>
  );
}

function EvidenceRow({ evidence, sweep }: { evidence: ProofCapsuleEvidence; sweep: boolean }) {
  return (
    <div className="relative mt-3.5 border-t border-proof-line-soft pt-3">
      {sweep ? (
        <div
          className="motion-safe:animate-proof-sweep pointer-events-none absolute inset-x-0 top-0 h-full bg-gradient-to-b from-proof-citron/25 to-transparent"
          aria-hidden="true"
        />
      ) : null}
      <div className="mb-2 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint">
        Evidence · 요구 대조
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-[13px] leading-[1.45] text-proof-ink-2">
        <span className="inline-flex items-center gap-1">
          <Check className="motion-safe:animate-proof-check-in size-3.5 text-proof-green" strokeWidth={3} aria-hidden="true" />
          AC {evidence.acMet}/{evidence.acTotal} 충족
        </span>
        {evidence.autoVerify === 'passed' ? (
          <span className="inline-flex items-center gap-1">
            <Check className="motion-safe:animate-proof-check-in size-3.5 text-proof-green" strokeWidth={3} aria-hidden="true" />
            자동검증 passed
          </span>
        ) : null}
        {evidence.autoVerify === 'failed' ? (
          <span className="text-proof-red">자동검증 failed</span>
        ) : null}
        {evidence.diff ? (
          <span className="font-mono text-[11px] text-proof-ink-3">diff +{evidence.diff.add} / −{evidence.diff.del}</span>
        ) : null}
      </div>
      {evidence.proofCount != null ? (
        <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-proof-ink-3">
          <ChevronDown className="size-3" aria-hidden="true" />
          증거 {evidence.proofCount}건
        </div>
      ) : null}
    </div>
  );
}

function GateRow({ gate, human }: { gate: ProofCapsuleGate; human: ProofCapsuleHuman }) {
  return (
    <div className="mt-3.5 border-t border-proof-line-soft pt-3">
      <div className="mb-2 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint">
        Human gate · 인간 = 책임 주체
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-[13px] text-proof-ink-2">
        <span>책임 <b className="text-proof-ink">{human.name}</b></span>
        <span className="font-mono text-[10.5px]">위험도 {gate.risk}</span>
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
  proofState, stateLabel, claim, human, agent, now, evidence, gate, className,
}: Omit<ProofCapsuleProps, 'density'>) {
  const sweep = useEvidenceSweep(evidence);
  return (
    <CutCornerShell state={proofState} cut={24} className={className}>
      <div className="min-w-0 flex-1 px-4.5 py-4">
        <StateHeader state={proofState} label={stateLabel} />
        <div className="mb-1 mt-3 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint">
          Claim · 에이전트 완료 주장
        </div>
        <div className="text-[19px] font-bold leading-[1.25] tracking-[-0.012em] text-proof-ink">{claim}</div>
        <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-proof-ink-3">
          {human ? (
            <span className="inline-flex items-center gap-1.5"><ProofAvatar label={initials(human.name)} />책임 {human.name}</span>
          ) : null}
          {agent ? (
            <span className="inline-flex items-center gap-1.5"><ProofAvatar label={agent.initial} isAgent />실행 {agent.name}</span>
          ) : null}
          {now ? <span className="text-proof-ink-2">지금: <b>{now}</b></span> : null}
          {proofState === 'blue' ? (
            <span className="inline-flex items-center gap-1.5 text-[10px] text-proof-ink-3">
              <span className="motion-safe:animate-proof-pulse size-1.5 rounded-full bg-proof-citron" aria-hidden="true" />
              실행 중
            </span>
          ) : null}
        </div>
        {evidence ? <EvidenceRow evidence={evidence} sweep={sweep} /> : null}
        {/* Human gate는 도크트린⑤(인간=책임 주체)상 책임자 없이 못 열림 — human 없으면 생략. */}
        {gate && human ? <GateRow gate={gate} human={human} /> : null}
      </div>
    </CutCornerShell>
  );
}

function CardVariant({ proofState, stateLabel, claim, evidence, footer, className }: Pick<ProofCapsuleProps, 'proofState' | 'stateLabel' | 'claim' | 'evidence' | 'footer' | 'className'>) {
  return (
    <CutCornerShell state={proofState} cut={16} className={cn('w-full max-w-[280px]', className)}>
      <div className="min-w-0 flex-1 px-3 py-2.5">
        <StateHeader state={proofState} label={stateLabel} />
        <div className="mt-1.5 line-clamp-2 text-[12.5px] font-semibold leading-snug text-proof-ink">{claim}</div>
        {evidence ? (
          <div className="mt-1.5 flex items-center gap-2.5 text-[10.5px] text-proof-ink-3">
            <span className="inline-flex items-center gap-1">
              <Check className="size-3 text-proof-green" strokeWidth={3} aria-hidden="true" />
              {evidence.acMet}/{evidence.acTotal}
            </span>
            {evidence.diff ? <span className="font-mono">+{evidence.diff.add}</span> : null}
          </div>
        ) : null}
        {footer}
      </div>
    </CutCornerShell>
  );
}

function InlineRow({ proofState, stateLabel, claim, gate, className }: Pick<ProofCapsuleProps, 'proofState' | 'stateLabel' | 'claim' | 'gate' | 'className'>) {
  return (
    <CutCornerShell state={proofState} cut={16} className={cn('w-full', className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5 px-3 py-2">
        <StateHeader state={proofState} label={stateLabel} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-proof-ink">{claim}</span>
        {gate ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <span className="font-mono text-[10.5px] text-proof-ink-3">위험 {gate.risk}</span>
            <a
              href={gate.href}
              className="rounded-[6px] border border-proof-blue bg-proof-blue-soft px-2.5 py-1 text-[10px] font-semibold text-proof-blue transition-colors duration-[140ms] hover:bg-proof-blue hover:text-white"
            >
              {gate.action}
            </a>
          </span>
        ) : null}
      </div>
    </CutCornerShell>
  );
}

function AuditRow({ proofState, claim, now, human, className }: Pick<ProofCapsuleProps, 'proofState' | 'claim' | 'now' | 'human' | 'className'>) {
  const dotTone: Record<ProofState, string> = {
    blue: 'bg-proof-blue', amber: 'bg-proof-amber', green: 'bg-proof-green', red: 'bg-proof-red',
  };
  return (
    <div className={cn('flex items-center gap-2 rounded-[6px] border border-proof-line bg-proof-panel px-3 py-2 text-[11px]', className)}>
      <span className={cn('size-1.5 shrink-0 rounded-full', dotTone[proofState])} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-proof-ink">{claim}</span>
      <span className="shrink-0 font-mono text-[9.5px] text-proof-faint">{[now, human?.name].filter(Boolean).join(' ')}</span>
    </div>
  );
}
