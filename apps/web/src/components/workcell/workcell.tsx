'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ProofAvatar, ProofCapsule, type ProofCapsuleProps, type ProofState } from '@/components/proof-capsule/proof-capsule';

export interface WorkcellOwner {
  name: string;
  role: string;
}

export interface WorkcellAgent {
  name: string;
  initial: string;
}

export interface WorkcellBrief {
  goal: string;
  dod: string;
  owner: WorkcellOwner;
  agent?: WorkcellAgent;
  scopes?: string[];
}

export interface WorkcellRun {
  now: string;
  stage: string;
  tools: string[];
  scopes: string[];
  blocked?: string | null;
  nextNeed: string;
}

export interface WorkcellMessage {
  author: string;
  body: string;
  resultLink?: string;
}

export type WorkcellConversationView = 'run' | 'evidence' | 'decision';

export interface WorkcellConversation {
  view: WorkcellConversationView;
  messages: WorkcellMessage[];
}

export interface WorkcellProps {
  title: string;
  proofState: ProofState;
  /** workcell-fe-spec-handoff §2 인터페이스엔 없지만, Proofline 자체(§1) 및 도크트린 ③(색만
   * 금지 텍스트 병기)이 이 헤더 배지에도 동일 적용 — ProofCapsule.stateLabel과 같은 관례로
   * 필수화(목업 pstate가 실제로 "실행 중" 텍스트를 렌더하므로 스펙 인터페이스의 누락 보완). */
  stateLabel: string;
  brief: WorkcellBrief;
  run: WorkcellRun;
  /** null = 아직 증거 없음(정직한 빈 상태) — Proof Capsule 컴포넌트 그대로 재사용. */
  evidence: ProofCapsuleProps | null;
  conversation: WorkcellConversation;
  className?: string;
}

const VIEW_LABEL: Record<WorkcellConversationView, string> = {
  run: '실행', evidence: '증거', decision: '결정',
};

const STATE_TONE: Record<ProofState, string> = {
  blue: 'text-proof-blue', amber: 'text-proof-amber', green: 'text-proof-green', red: 'text-proof-red',
};
const STATE_DOT: Record<ProofState, string> = {
  blue: 'bg-proof-blue', amber: 'bg-proof-amber', green: 'bg-proof-green', red: 'bg-proof-red',
};

/**
 * Workcell — Story 상세 우측 패널의 4층 재구성(workcell-fe-spec-handoff). "10초 리트머스":
 * 열고 10초 안에 무엇을(Brief)·누가(Brief)·어디까지(Run+Evidence)·무엇이 필요한지(Run
 * nextNeed) 답 가능해야 한다. Brief(약속)→Run(현재행위+다음요구, 진행률바 없음)→Evidence
 * (Proof Capsule 재사용)→Conversation(작업-귀속, 전역 chat과 분리) 순.
 *
 * 도크트린 5 준수: ①약속>활동(Brief가 최상단) ②주장>로그(활동 로그 필드 자체가 없음)
 * ③예외 선명(막힘은 숨기지 않되 빨강 아닌 info 톤) ④자동화 경계(agent 마커 항상 구분)
 * ⑤인간=책임 주체(Evidence의 Human gate가 결정점). 안티패턴 0 — 진행률 바(%) 자체를
 * 렌더하지 않는 게 Run 층의 핵심 계약.
 */
export function Workcell({ title, proofState, stateLabel, brief, run, evidence, conversation, className }: WorkcellProps) {
  return (
    <div
      className={cn('overflow-hidden rounded-[6px] border border-proof-line bg-proof-panel', className)}
      style={{ clipPath: 'polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 0 100%)' }}
    >
      <div className="flex items-center gap-3 border-b border-proof-line px-4.5 py-3.5">
        <span className="text-[17px] font-bold leading-tight tracking-[-0.012em] text-proof-ink">{title}</span>
        <span className={cn('ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold', STATE_TONE[proofState])}>
          <span className={cn('size-1.5 rounded-full', STATE_DOT[proofState])} aria-hidden="true" />
          {stateLabel}
        </span>
      </div>

      <BriefLayer brief={brief} />
      <RunLayer run={run} />
      <EvidenceLayer evidence={evidence} />
      <ConversationLayer conversation={conversation} />
    </div>
  );
}

function LayerLabel({ title, question, className }: { title: string; question: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-1.5 text-[8.5px] font-bold uppercase tracking-[0.12em] text-proof-faint', className)}>
      {title}
      <span className="text-[9.5px] font-semibold normal-case tracking-normal text-proof-ink-3">— {question}</span>
    </div>
  );
}

function BriefLayer({ brief }: { brief: WorkcellBrief }) {
  return (
    <div className="border-b border-proof-line-soft px-4.5 py-3.5">
      <LayerLabel title="Brief" question="무엇을 · 왜 (약속)" className="mb-2.5" />
      <div className="flex gap-2 text-[13px] leading-[1.5] text-proof-ink-2">
        <span className="w-16 shrink-0 pt-px text-[11px] text-proof-faint">목표</span>
        <span className="text-proof-ink">{brief.goal}</span>
      </div>
      <div className="mt-1.5 flex gap-2 text-[13px] leading-[1.5] text-proof-ink-2">
        <span className="w-16 shrink-0 pt-px text-[11px] text-proof-faint">완료정의</span>
        <span className="text-proof-ink">{brief.dod}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 gap-y-1.5 text-[13px] leading-[1.5] text-proof-ink-2">
        <span className="w-16 shrink-0 pt-px text-[11px] text-proof-faint">권한</span>
        <span className="inline-flex items-center gap-1.5"><ProofAvatar label={brief.owner.name.slice(0, 1)} size={18} />책임 {brief.owner.name}</span>
        {brief.agent ? (
          <span className="inline-flex items-center gap-1.5"><ProofAvatar label={brief.agent.initial} isAgent size={18} />실행 {brief.agent.name}</span>
        ) : null}
        {brief.scopes && brief.scopes.length > 0 ? (
          <span className="font-mono text-[10.5px] text-proof-ink-3">{brief.scopes.join(' · ')}</span>
        ) : null}
      </div>
    </div>
  );
}

function RunLayer({ run }: { run: WorkcellRun }) {
  return (
    <div className="border-b border-proof-line-soft px-4.5 py-3.5">
      <LayerLabel title="Run" question="어디까지 · 무엇이 필요 (현재 행위, 진행률바 아님)" className="mb-2.5" />
      <div className="mb-2 text-[13.5px] font-semibold text-proof-ink">지금: {run.now}</div>
      <div className="mb-2.5 flex flex-wrap gap-3.5 text-[11px] text-proof-ink-3">
        <span>단계 <b className="font-semibold text-proof-ink-2">{run.stage}</b></span>
        {run.tools.length > 0 ? <span className="font-mono text-[10.5px]">도구 {run.tools.join(', ')}</span> : null}
        {run.scopes.length > 0 ? <span className="font-mono text-[10.5px]">권한 {run.scopes.join(', ')}</span> : null}
      </div>
      <div className="mb-2 text-[11.5px] text-proof-ink-3">
        막힘: <b className={cn('font-semibold', run.blocked ? 'text-proof-amber' : 'text-proof-ink-2')}>{run.blocked ?? '없음'}</b>
      </div>
      <div className="flex items-center gap-1.5 rounded-[6px] border border-proof-blue/25 bg-proof-blue-soft px-2.5 py-1.5 text-[12.5px] text-proof-blue">
        → 다음 요구: <b className="font-bold">{run.nextNeed}</b>
      </div>
    </div>
  );
}

function EvidenceLayer({ evidence }: { evidence: ProofCapsuleProps | null }) {
  return (
    <div className="border-b border-proof-line-soft px-4.5 py-3.5">
      <LayerLabel title="Evidence" question="증명 (Proof Capsule 재사용 · done=라벨 아니라 증거)" className="mb-2.5" />
      {evidence ? (
        <ProofCapsule {...evidence} />
      ) : (
        <p className="rounded-[6px] border border-dashed border-proof-line bg-proof-sunk px-3 py-2.5 text-[11.5px] text-proof-faint">
          아직 증거 없음
        </p>
      )}
    </div>
  );
}

function ConversationLayer({ conversation }: { conversation: WorkcellConversation }) {
  const [view, setView] = useState<WorkcellConversationView>(conversation.view);
  return (
    <div className="px-4.5 py-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <LayerLabel title="Conversation" question="작업-귀속 스레드 (전역 chat 아님)" />
        <div className="ml-auto inline-flex overflow-hidden rounded-[6px] border border-proof-line">
          {(['run', 'evidence', 'decision'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'px-2.5 py-1 text-[10px] transition-colors duration-[140ms]',
                v === view ? 'bg-proof-sunk font-semibold text-proof-ink' : 'text-proof-ink-3',
              )}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>
      {conversation.messages.length === 0 ? (
        <p className="text-[11.5px] text-proof-faint">아직 메시지가 없습니다</p>
      ) : (
        <div className="space-y-1">
          {conversation.messages.map((m, i) => (
            <div key={i} className="flex gap-2 py-0.5 text-[12.5px] leading-[1.5] text-proof-ink-2">
              <span className="shrink-0 whitespace-nowrap font-semibold text-proof-ink">{m.author}</span>
              <span className="min-w-0">
                {m.body}
                {m.resultLink ? <span className="ml-1.5 font-mono text-[10.5px] text-proof-blue">{m.resultLink}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] text-proof-faint">
        이 작업에 귀속된 지시·판단·증거·수정요청만. 뷰 전환(실행/증거/결정)=같은 스레드 다른 렌즈.
      </p>
    </div>
  );
}
