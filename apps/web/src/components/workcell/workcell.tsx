'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { ProofCapsule, type ProofCapsuleProps } from '@/components/proof-capsule/proof-capsule';
import { Proofline, type ProofState } from '@/components/proof-capsule/proofline';
import { Avatar } from '@/components/shared/avatar';

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

/** story #2922(P0-D 재설계) — 신뢰 파이프라인 6상태. 현행 5-status(backlog/ready-for-dev/
 * in-progress/in-review/done)로는 표현 못 하는 needs_input·verified는 파생(호출부 책임,
 * doc workcell-redesign-2922 §매핑표). 순서 자체가 파이프라인 진행 축(STAGES 배열과 동일). */
export type WorkcellPipelineStage = 'queued' | 'running' | 'needs_input' | 'claimed_done' | 'verified' | 'merge_ready';

export interface WorkcellProps {
  title: string;
  /** story #2922 — 구 단일 proofState 배지(3색 점+텍스트)를 헤더 6상태 파이프라인 스테퍼로
   * 대체(doc workcell-redesign-2922 축②). */
  pipelineStage: WorkcellPipelineStage;
  brief: WorkcellBrief;
  run: WorkcellRun;
  /** null = 아직 증거 없음(정직한 빈 상태) — Proof Capsule 컴포넌트 그대로 재사용. */
  evidence: ProofCapsuleProps | null;
  conversation: WorkcellConversation;
  className?: string;
}

const PIPELINE_STAGES: WorkcellPipelineStage[] = ['queued', 'running', 'needs_input', 'claimed_done', 'verified', 'merge_ready'];

// story #2922 W6 — 유나양 확定 트러스트-시맨틱 컬러 매핑(2026-08-22, 시안 335f138d 갱신).
// 색=그 단계 자체의 신뢰상태(위치 무관 고정) — Running/Claimed done=blue(실행·주장,
// 미검증)·Needs input=amber(대기)·Verified/Merge-ready=green(증명). Queued는 매핑에 없음
// (아직 신호 자체가 없다 — 4색 중 어느 것도 지어내지 않고 중립 faint/line 토큰으로 대체).
// 레일(Proofline)과 헤더 스테퍼 둘 다 이 SSOT 하나를 공유(동작 이중선언 금지).
const PIPELINE_STAGE_TRUST_COLOR: Partial<Record<WorkcellPipelineStage, ProofState>> = {
  running: 'blue', needs_input: 'amber', claimed_done: 'blue', verified: 'green', merge_ready: 'green',
};

const TRUST_TEXT_CLASS: Record<ProofState, string> = {
  blue: 'text-proof-blue', amber: 'text-proof-amber', green: 'text-proof-green', red: 'text-proof-red',
};
const TRUST_BG_CLASS: Record<ProofState, string> = {
  blue: 'bg-proof-blue', amber: 'bg-proof-amber', green: 'bg-proof-green', red: 'bg-proof-red',
};
const TRUST_BORDER_CLASS: Record<ProofState, string> = {
  blue: 'border-proof-blue', amber: 'border-proof-amber', green: 'border-proof-green', red: 'border-proof-red',
};
const TRUST_RING_CLASS: Record<ProofState, string> = {
  blue: 'ring-proof-blue/20', amber: 'ring-proof-amber/20', green: 'ring-proof-green/20', red: 'ring-proof-red/20',
};

function PipelineStepper({ stage }: { stage: WorkcellPipelineStage }) {
  const t = useTranslations('workcell');
  const label: Record<WorkcellPipelineStage, string> = {
    queued: t('pipelineQueued'), running: t('pipelineRunning'), needs_input: t('pipelineNeedsInput'),
    claimed_done: t('pipelineClaimedDone'), verified: t('pipelineVerified'), merge_ready: t('pipelineMergeReady'),
  };
  const curIdx = PIPELINE_STAGES.indexOf(stage);
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-x-0 gap-y-1" role="list" aria-label={t('pipelineQuestion')}>
      {PIPELINE_STAGES.map((s, i) => {
        const isCurrent = i === curIdx;
        const color = PIPELINE_STAGE_TRUST_COLOR[s];
        // story #2922 W6 델타(유나양 확定) — 색=신뢰상태(위치 무관, 위 표) · 강조=위치
        // (ring/weight/dot-fill로만, current만 채워진 점+ring+굵기). "지나온" 단계라고
        // 강제로 초록 처리하지 않는다 — 그 자체가 이미 초록(예: verified)이 아닌 한.
        return (
          <span key={s} className="flex items-center" role="listitem">
            <span
              className={cn(
                'flex items-center gap-1.5 pr-1.5 text-[9px] leading-none',
                color ? TRUST_TEXT_CLASS[color] : 'text-proof-faint',
                isCurrent && 'font-bold',
                !isCurrent && 'font-semibold',
              )}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  isCurrent
                    ? cn(color ? TRUST_BG_CLASS[color] : 'bg-proof-line', 'ring-2', color ? TRUST_RING_CLASS[color] : 'ring-proof-line/40')
                    : cn('border bg-transparent', color ? TRUST_BORDER_CLASS[color] : 'border-proof-line'),
                )}
                aria-hidden="true"
              />
              {label[s]}
            </span>
            {i < PIPELINE_STAGES.length - 1 ? <span className="px-1 text-[9px] text-proof-line" aria-hidden="true">›</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Workcell — Story 상세 우측 패널의 4구획 재구성(story #2922 P0-D, workcell-fe-spec-handoff
 * 초판 위 재설계). "10초 리트머스": 열고 10초 안에 무엇을(Brief)·누가(Brief)·어디까지
 * (Run+Evidence)·무엇이 필요한지(Run nextNeed) 답 가능해야 한다. 2×2 구획(Brief|Run /
 * Evidence|Conversation, 탭 0)+헤더 신뢰 파이프라인 6상태 스테퍼(Queued→…→Merge-ready).
 *
 * 도크트린 5 준수: ①약속>활동(Brief가 좌상단) ②주장>로그(활동 로그 필드 자체가 없음)
 * ③예외 선명(막힘은 숨기지 않되 빨강 아닌 info 톤, 파이프라인 단계도 색+텍스트 병기)
 * ④자동화 경계(agent 마커 항상 구분) ⑤인간=책임 주체(Evidence의 Human gate가 결정점).
 * 안티패턴 0 — 진행률 바(%) 자체를 렌더하지 않는 게 Run 구획의 핵심 계약.
 */
export function Workcell({ title, pipelineStage, brief, run, evidence, conversation, className }: WorkcellProps) {
  const t = useTranslations('workcell');
  const railState = PIPELINE_STAGE_TRUST_COLOR[pipelineStage];
  return (
    <div
      className={cn('flex overflow-hidden rounded-[6px] border border-proof-line bg-proof-panel', className)}
      style={{ clipPath: 'polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 0 100%)' }}
    >
      {/* story #2922 W6(선행 조각) — Proofline 좌측 레일(ProofCapsule CutCornerShell과 동형
          부품 재사용, 신규 컴포넌트 0). */}
      {railState ? <Proofline state={railState} /> : <div className="w-1 shrink-0 self-stretch bg-proof-line" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="border-b border-proof-line px-4.5 py-3.5">
          <PipelineStepper stage={pipelineStage} />
          <span className="text-[17px] font-bold leading-tight tracking-[-0.012em] text-proof-ink">{title}</span>
          {/* story #2922 W4 — 책임자/실행자를 헤더로 승격("10초 리트머스": 스크롤 없이 «누가»가
              보임). #3339(2921 아바타 단일통합)가 ProofAvatar를 폐기·Avatar로 수렴시켰다 —
              여기도 그 정본을 그대로 소비(신규 변형 0). Brief 구획의 중복 표기는 제거(SSOT=
              헤더 이 한 자리). */}
          <div className="mt-2 flex flex-wrap items-center gap-3.5 text-[11px] text-proof-ink-3">
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={brief.owner.name} actorType="human" size={18} />
              {t('briefOwner')} {brief.owner.name}
            </span>
            {brief.agent ? (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={brief.agent.name} actorType="agent" size={18} />
                {t('briefAgent')} {brief.agent.name}
              </span>
            ) : null}
          </div>
        </div>

        {/* story #2922 W1 — 4구획 세로 나열 → 2×2 그리드(Brief|Run / Evidence|Conversation).
            gap-px+bg-proof-line가 각 구획 사이 헤어라인을 만든다(개별 레이어의 border-b는
            이제 이 그리드 갭과 중복이라 제거됨). */}
        <div className="grid grid-cols-2 gap-px bg-proof-line">
          <div className="bg-proof-panel"><BriefLayer brief={brief} /></div>
          <div className="bg-proof-panel"><RunLayer run={run} /></div>
          <div className="bg-proof-panel"><EvidenceLayer evidence={evidence} /></div>
          <div className="bg-proof-panel"><ConversationLayer conversation={conversation} /></div>
        </div>
      </div>
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
  const t = useTranslations('workcell');
  return (
    <div className="h-full px-4.5 py-3.5">
      <LayerLabel title="Brief" question={t('briefQuestion')} className="mb-2.5" />
      <div className="flex gap-2 text-[13px] leading-[1.5] text-proof-ink-2">
        <span className="w-16 shrink-0 pt-px text-[11px] text-proof-faint">{t('briefGoal')}</span>
        <span className="text-proof-ink">{brief.goal}</span>
      </div>
      <div className="mt-1.5 flex gap-2 text-[13px] leading-[1.5] text-proof-ink-2">
        <span className="w-16 shrink-0 pt-px text-[11px] text-proof-faint">{t('briefDod')}</span>
        <span className="text-proof-ink">{brief.dod}</span>
      </div>
      {/* story #2922 W4 — owner/agent는 헤더로 승격됐다(위 Workcell 헤더 참조, SSOT 이동).
          scopes만 남아 briefRoles 라벨을 계승. */}
      {brief.scopes && brief.scopes.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] leading-[1.5] text-proof-ink-2">
          <span className="w-16 shrink-0 pt-px text-[11px] text-proof-faint">{t('briefRoles')}</span>
          <span className="font-mono text-[10.5px] text-proof-ink-3">{brief.scopes.join(' · ')}</span>
        </div>
      ) : null}
    </div>
  );
}

function RunLayer({ run }: { run: WorkcellRun }) {
  const t = useTranslations('workcell');
  return (
    <div className="h-full px-4.5 py-3.5">
      <LayerLabel title="Run" question={t('runQuestion')} className="mb-2.5" />
      <div className="mb-2 text-[13.5px] font-semibold text-proof-ink">{t('runNow')}: {run.now}</div>
      <div className="mb-2.5 flex flex-wrap gap-3.5 text-[11px] text-proof-ink-3">
        <span>{t('runStage')} <b className="font-semibold text-proof-ink-2">{run.stage}</b></span>
        {run.tools.length > 0 ? <span className="font-mono text-[10.5px]">{t('runTools')} {run.tools.join(', ')}</span> : null}
        {run.scopes.length > 0 ? <span className="font-mono text-[10.5px]">{t('runScopes')} {run.scopes.join(', ')}</span> : null}
      </div>
      <div className="mb-2 text-[11.5px] text-proof-ink-3">
        {t('runBlocked')}: <b className={cn('font-semibold', run.blocked ? 'text-proof-amber' : 'text-proof-ink-2')}>{run.blocked ?? t('none')}</b>
      </div>
      <div className="flex items-center gap-1.5 rounded-[6px] border border-proof-blue/25 bg-proof-blue-soft px-2.5 py-1.5 text-[12.5px] text-proof-blue">
        → {t('runNextNeed')}: <b className="font-bold">{run.nextNeed}</b>
      </div>
    </div>
  );
}

function EvidenceLayer({ evidence }: { evidence: ProofCapsuleProps | null }) {
  const t = useTranslations('workcell');
  return (
    <div className="h-full px-4.5 py-3.5">
      <LayerLabel title="Evidence" question={t('evidenceQuestion')} className="mb-2.5" />
      {evidence ? (
        <ProofCapsule {...evidence} />
      ) : (
        <p className="rounded-[6px] border border-dashed border-proof-line bg-proof-sunk px-3 py-2.5 text-[11.5px] text-proof-faint">
          {t('evidenceEmpty')}
        </p>
      )}
    </div>
  );
}

function ConversationLayer({ conversation }: { conversation: WorkcellConversation }) {
  const t = useTranslations('workcell');
  const [view, setView] = useState<WorkcellConversationView>(conversation.view);
  const viewLabel: Record<WorkcellConversationView, string> = {
    run: t('viewRun'), evidence: t('viewEvidence'), decision: t('viewDecision'),
  };
  return (
    <div className="h-full px-4.5 py-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <LayerLabel title="Conversation" question={t('conversationQuestion')} />
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
              {viewLabel[v]}
            </button>
          ))}
        </div>
      </div>
      {conversation.messages.length === 0 ? (
        <p className="text-[11.5px] text-proof-faint">{t('conversationEmpty')}</p>
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
        {t('conversationFooter')}
      </p>
    </div>
  );
}
