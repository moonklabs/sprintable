'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ChevronRight } from 'lucide-react';
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
  /** story #2993(PO 확定①) — 에이전트 단독배정 스토리도 Workcell을 렌더한다(허구 human
   * 금지 원칙은 유지 — 없으면 null로 정직하게 "책임자 미지정" 표시, 지어내지 않음). */
  owner: WorkcellOwner | null;
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

/** story #2922 W5 — ChatProofSection(대화 근거) 요약. count=null은 확認된 0건(정직한
 * "연결된 대화 없음"), undefined는 아직 모름(로딩 중 — 이 요약 자체를 렌더 보류, 성급한
 * "없음" 단정 방지). href는 count>0일 때만 의미 있음. */
export interface WorkcellChatProofSummary {
  count: number | null;
  href: string | null;
}

export interface WorkcellConversation {
  view: WorkcellConversationView;
  messages: WorkcellMessage[];
  chatProof?: WorkcellChatProofSummary;
}

/** story #2922(P0-D 재설계) — 신뢰 파이프라인 6상태. 현행 5-status(backlog/ready-for-dev/
 * in-progress/in-review/done)로는 표현 못 하는 needs_input·verified는 파생(호출부 책임,
 * doc workcell-redesign-2922 §매핑표). 순서 자체가 파이프라인 진행 축(STAGES 배열과 동일). */
export type WorkcellPipelineStage = 'queued' | 'running' | 'needs_input' | 'claimed_done' | 'verified' | 'merge_ready';

export interface WorkcellProps {
  title: string;
  /** story #2922 — 구 단일 proofState 배지(3색 점+텍스트)를 헤더 6상태 파이프라인 스테퍼로
   * 대체(doc workcell-redesign-2922 축②). story #2993(PO 확定②) — null=이 스토리가 신뢰
   * 파이프라인 스코프 밖(현재는 done만 해당, BE trust_pipeline.derive_trust_stage §7 확定④
   * 그대로)일 때. status 기반 합성 stage로 되돌리지 않고(#2933 H1 조건②가 금지) 정직한
   * "파이프라인 범위 밖" 표시로 대체한다. */
  pipelineStage: WorkcellPipelineStage | null;
  brief: WorkcellBrief;
  run: WorkcellRun;
  /** null = 아직 증거 없음(정직한 빈 상태) — Proof Capsule 컴포넌트 그대로 재사용. */
  evidence: ProofCapsuleProps | null;
  conversation: WorkcellConversation;
  className?: string;
  /** story #2984 §6(가역성 1급) — bento 형태·재질 재편(§1~§4) 켜기/끄기 단일 스위치.
   * 기본값 true(선생님 결재 confirm으로 라이브 기본). 선생님 라이브 감이 반려되면 이
   * 기본값 한 줄(true→false)만 뒤집으면 균등 2×2 + 색 스테퍼로 전체 복귀(D0 세리프
   * 토큰 복귀 선례와 동형 — 개별 소비처 산개 금지, 이 prop 하나만 경유). */
  bentoLayout?: boolean;
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

// story #2984 §3(doc workcell-bento-form-material-spec-2984, 유나 설계·선생님 결재 confirm) —
// 6단계 신뢰를 «채움 눈금 + 도달 노드»(물리량)로 표기. 색 스테퍼(PipelineStepper)의 색맹·
// 저대비 취약점을 없앤다 — 색은 §7 규율대로 의미 신호로만 남긴다(이 게이지는 무채색).
// 노드 위치는 트랙 8%~95% 구간에 6개를 균등 배치(끝 여백 확보). fill은 "마지막 도달 노드
// 위치 + 다음 노드까지 절반"까지 채운다 — "이 단계까지 왔고, 다음으로 가는 중"을 물리적으로
// 읽히게 하는 의도(유나 시안 db9bdfdf의 66%↔3/6 오버슛 관찰과 동형 원리, 정확한 %는 실 렌더
// 여백 기준으로 재계산했다 — 시안 픽셀값을 그대로 베끼지 않음, 조정 필요하면 이 상수만).
const CONFIDENCE_NODE_START_PCT = 8;
const CONFIDENCE_NODE_END_PCT = 95;

function nodePositions(): number[] {
  const span = CONFIDENCE_NODE_END_PCT - CONFIDENCE_NODE_START_PCT;
  const step = span / (PIPELINE_STAGES.length - 1);
  return PIPELINE_STAGES.map((_, i) => CONFIDENCE_NODE_START_PCT + i * step);
}

function ConfidenceGauge({ stage }: { stage: WorkcellPipelineStage }) {
  const t = useTranslations('workcell');
  const label: Record<WorkcellPipelineStage, string> = {
    queued: t('pipelineQueued'), running: t('pipelineRunning'), needs_input: t('pipelineNeedsInput'),
    claimed_done: t('pipelineClaimedDone'), verified: t('pipelineVerified'), merge_ready: t('pipelineMergeReady'),
  };
  const curIdx = PIPELINE_STAGES.indexOf(stage);
  const reachedCount = curIdx + 1; // 현재 단계까지 포함해 "도달"로 센다(mockup 3/6 판독과 동형).
  const positions = nodePositions();
  const lastReachedPos = positions[reachedCount - 1] ?? CONFIDENCE_NODE_START_PCT;
  const nextPos = positions[reachedCount];
  const fillPct = reachedCount >= PIPELINE_STAGES.length
    ? 100
    : lastReachedPos + (nextPos! - lastReachedPos) / 2;

  return (
    <div className="mb-2.5" role="progressbar" aria-valuemin={0} aria-valuemax={PIPELINE_STAGES.length} aria-valuenow={reachedCount} aria-valuetext={`${reachedCount}/${PIPELINE_STAGES.length} · ${label[stage]}`}>
      <div className="flex items-center gap-2.5">
        <div className="relative h-[22px] flex-1 overflow-hidden rounded-[4px] bg-proof-sunk">
          {/* story #2984 §3 — 물리량 채움. 두 톤 반복 눈금(색 신호 아님, --proof-sunk/--proof-ink-3
              에서 color-mix로 파생 — 신규 하드코딩 색 0, §7 규율). */}
          <div
            className="absolute inset-y-0 left-0"
            style={{
              width: `${fillPct}%`,
              backgroundImage: 'repeating-linear-gradient(90deg, color-mix(in oklch, var(--proof-sunk) 35%, var(--proof-ink-3) 65%) 0 15px, color-mix(in oklch, var(--proof-sunk) 15%, var(--proof-ink-3) 85%) 15px 16px)',
            }}
          />
          {positions.map((pos, i) => (
            <span
              key={PIPELINE_STAGES[i]}
              className={cn(
                'absolute top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]',
                i < reachedCount ? 'border-proof-ink bg-proof-ink' : 'border-proof-line-strong bg-proof-panel',
              )}
              style={{ left: `${pos}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
        <span className="whitespace-nowrap font-mono text-[10px] text-proof-ink-3">
          {t('confidenceCaption', { done: reachedCount, total: PIPELINE_STAGES.length })}
        </span>
      </div>
      <p className="mt-1 text-[11px] font-semibold text-proof-ink-2" data-testid="workcell-current-stage">{label[stage]}</p>
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
export function Workcell({ title, pipelineStage, brief, run, evidence, conversation, className, bentoLayout = true }: WorkcellProps) {
  const t = useTranslations('workcell');
  const railState = pipelineStage ? PIPELINE_STAGE_TRUST_COLOR[pipelineStage] : undefined;
  return (
    // story #2955 §5 — 인라인 clip-path를 정본 `.proof-cut` 유틸(globals.css)로 이관(24px 기본값 그대로).
    <div className={cn('proof-cut flex overflow-hidden rounded-[6px] border border-proof-line bg-proof-panel', className)}>
      {/* story #2922 W6(선행 조각) — Proofline 좌측 레일(ProofCapsule CutCornerShell과 동형
          부품 재사용, 신규 컴포넌트 0). */}
      {railState ? <Proofline state={railState} /> : <div className="w-1 shrink-0 self-stretch bg-proof-line" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="border-b border-proof-line px-4.5 py-3.5">
          {/* story #2984 §3/§6 — bentoLayout=true(기본)면 색 스테퍼 대신 물리량 게이지.
              story #2993(PO 확定②) — pipelineStage=null이면 게이지/스테퍼 대신 정직한
              "파이프라인 범위 밖" 표시(합성 stage 금지, #2933 H1 조건②). */}
          {pipelineStage
            ? (bentoLayout ? <ConfidenceGauge stage={pipelineStage} /> : <PipelineStepper stage={pipelineStage} />)
            : <p className="text-[11px] font-semibold text-proof-ink-3" data-testid="workcell-out-of-pipeline">{t('outOfPipeline')}</p>}
          <span className="text-[17px] font-bold leading-tight tracking-[-0.012em] text-proof-ink">{title}</span>
          {/* story #2922 W4 — 책임자/실행자를 헤더로 승격("10초 리트머스": 스크롤 없이 «누가»가
              보임). #3339(2921 아바타 단일통합)가 ProofAvatar를 폐기·Avatar로 수렴시켰다 —
              여기도 그 정본을 그대로 소비(신규 변형 0). Brief 구획의 중복 표기는 제거(SSOT=
              헤더 이 한 자리). story #2993(PO 확定①) — owner=null(에이전트 단독배정)이면
              지어내지 않고 "책임자 미지정" 정직 표시(muted). */}
          <div className="mt-2 flex flex-wrap items-center gap-3.5 text-[11px] text-proof-ink-3">
            <span className="inline-flex items-center gap-1.5">
              {brief.owner ? (
                <>
                  <Avatar name={brief.owner.name} actorType="human" size={18} />
                  {t('briefOwner')} {brief.owner.name}
                </>
              ) : (
                // story #2993 — 유나 design 판정(2026-08-24): text-proof-faint는 라이트 대비
                // ~2.72(AA 미달)+"조용히 소실"이라 지정을 촉진 못 함. text-proof-ink-3(4.9)로
                // 상향 — 읽히되 과하지 않은 muted.
                <span className="text-proof-ink-3">{t('ownerUnassigned')}</span>
              )}
            </span>
            {brief.agent ? (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={brief.agent.name} actorType="agent" size={18} />
                {t('briefAgent')} {brief.agent.name}
              </span>
            ) : null}
          </div>
        </div>

        {bentoLayout ? (
          // story #2984 §1/§2/§4 — 균등 2×2 → 크기 차등 bento(Evidence=최우선 큰 셀)+계보
          // 연결선+Evidence만 elevation. 가운데 4px 열은 연결선 전용 트랙(§2) — 매직 픽셀
          // 좌표 없이 CSS Grid 라인에 그대로 앵커링해 실 렌더 폰트/패딩에 안 흔들린다.
          // story bc9ee586(critical, 선생님 실사고 2026-08-24) — 3열 그리드가 모바일에서
          // 그대로 유지돼 Evidence 제목 어절 세로 낙하·Run CTA 글자 꺾임. base=단일 컬럼
          // 스택(DOM 순서 그대로 Evidence→Run→Brief→Conversation), lg: 이상만 3열 그리드로
          // 전환(GNB lg:hidden과 일치하는 breakpoint — CLAUDE.md md 사용 금지 규율이라
          // 페드루군 구두 지시의 "md:"를 lg:로 치환). 계보 연결선은 모바일에서 숨김.
          <div className="relative grid grid-cols-1 gap-3 p-3 lg:grid-cols-[1.7fr_4px_1fr] lg:grid-rows-[auto_auto_auto]">
            <div className="hidden lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:flex lg:justify-center" aria-hidden="true">
              <div className="relative w-[1.5px] bg-proof-line-strong">
                <span className="absolute left-1/2 top-0 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-proof-ink" />
                <span className="absolute left-1/2 top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-proof-ink" />
              </div>
            </div>
            {/* story #2990 §4 fast-follow(유나 확定) — elev-overlay(오버레이 전용)는 인라인
                카드에 과한 "팝오버처럼 분리" 신호라 elev-card(인라인 카드 전용, 약한 강도)로
                교체. */}
            <div className="lg:col-start-1 lg:row-start-1 lg:row-span-2 overflow-hidden rounded-[10px] border border-proof-line-strong bg-proof-panel shadow-[var(--elev-card)]">
              <EvidenceLayer evidence={evidence} />
            </div>
            <div className="lg:col-start-3 lg:row-start-1 overflow-hidden rounded-[10px] border border-proof-line bg-proof-panel shadow-[0_1px_0_var(--proof-line)]">
              <RunLayer run={run} />
            </div>
            <div className="lg:col-start-3 lg:row-start-2 overflow-hidden rounded-[10px] border border-proof-line bg-proof-panel shadow-[0_1px_0_var(--proof-line)]">
              <BriefLayer brief={brief} />
            </div>
            <div className="lg:col-span-3 lg:row-start-3 overflow-hidden rounded-[10px] border border-proof-line bg-proof-panel shadow-[0_1px_0_var(--proof-line)]">
              <ConversationLayer conversation={conversation} />
            </div>
          </div>
        ) : (
          // story #2922 W1 — 4구획 세로 나열 → 2×2 그리드(Brief|Run / Evidence|Conversation).
          // gap-px+bg-proof-line가 각 구획 사이 헤어라인을 만든다(개별 레이어의 border-b는
          // 이제 이 그리드 갭과 중복이라 제거됨).
          <div className="grid grid-cols-2 gap-px bg-proof-line">
            <div className="bg-proof-panel"><BriefLayer brief={brief} /></div>
            <div className="bg-proof-panel"><RunLayer run={run} /></div>
            <div className="bg-proof-panel"><EvidenceLayer evidence={evidence} /></div>
            <div className="bg-proof-panel"><ConversationLayer conversation={conversation} /></div>
          </div>
        )}
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

/**
 * story #2922 W5 — Conversation 구획 본체 = ChatProofSection 요약(스레드 건수+대화 링크,
 * compact — "10초 리트머스" 유지). 유나양 확定 4규칙: ①본체=요약 ②story 댓글=하위 접힘
 * disclosure(기능 무손실, 교체 아님) ③위계(챗=주·댓글=부, 평평 나열 금지) ④0건 정직표시
 * (댓글 0=disclosure 자체 미표시·스레드 0=「연결된 대화 없음」 명시, 침묵 아님).
 */
function ChatProofSummaryRow({ summary }: { summary: WorkcellChatProofSummary | undefined }) {
  const t = useTranslations('workcell');
  // undefined = 아직 모름(로딩 중) — "없음"을 성급히 단정하지 않고 렌더 자체를 보류(no-fiction).
  if (summary === undefined) return null;
  if (summary.count === null || summary.count === 0) {
    return <p className="text-[11.5px] text-proof-faint">{t('conversationNoThreads')}</p>;
  }
  return (
    <a
      href={summary.href ?? undefined}
      className="inline-flex items-center gap-1 text-[13px] font-medium text-proof-blue hover:underline"
    >
      {t('conversationChatProofCount', { count: summary.count })}
      <ArrowRight className="size-3" aria-hidden="true" />
    </a>
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
      <LayerLabel title="Conversation" question={t('conversationQuestion')} className="mb-2.5" />
      <ChatProofSummaryRow summary={conversation.chatProof} />
      {conversation.messages.length > 0 ? (
        <details className="mt-2.5 group">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-proof-ink-3 marker:content-none">
            <span className="inline-flex items-center gap-1">
              <ChevronRight className="size-3 transition-transform duration-[140ms] group-open:rotate-90" aria-hidden="true" />
              {t('conversationCommentsDisclosure', { count: conversation.messages.length })}
            </span>
          </summary>
          <div className="mt-2 border-t border-proof-line-soft pt-2">
            <div className="mb-2 flex items-center justify-end">
              <div className="inline-flex overflow-hidden rounded-[6px] border border-proof-line">
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
            <p className="mt-2 text-[10px] text-proof-faint">
              {t('conversationFooter')}
            </p>
          </div>
        </details>
      ) : null}
    </div>
  );
}
