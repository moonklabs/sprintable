'use client';

import { useTranslations } from 'next-intl';
import {
  ProofCapsule,
  type ProofState,
  type ProofCapsuleEvidence,
  type ProofCapsuleGate,
} from '@/components/proof-capsule/proof-capsule';
import type { TrustSealClaimedProps, TrustSealVerifiedProps } from '@/components/verify/trust-seal';
import { initials, formatDate } from '@/lib/storage/format';
import { heroProofState, splitParticipants, type HeroStory, type HeroMember } from './hero-logic';
import { synthesizeGateAction, type HeroEnvelope } from './derive-hero-envelope';

interface GlanceHeroProps {
  story: HeroStory;
  memberMap: Record<string, HeroMember>;
  /** #2099 hero envelope. 없음/형상붕괴(null)면 claim+state+참여자만 렌더(최소 폴백·no-fiction). */
  envelope?: HeroEnvelope | null;
}

const STATE_LABEL_KEY: Record<ProofState, string> = {
  blue: 'heroStateInProgress',
  amber: 'heroStateReviewing',
  green: 'heroStateProven',
  red: 'heroStateViolation',
};

/**
 * envelope의 proof_count·auto_verify를 Evidence 섹션으로. 무증거(proof 0 + auto 없음)면 섹션 자체
 * 생략(정직 최소). ⛔ac/risk/diff는 envelope에 없고 렌더도 안 함(계약 no-fiction).
 */
function buildEvidence(envelope: HeroEnvelope | null | undefined): ProofCapsuleEvidence | undefined {
  if (!envelope) return undefined;
  const hasProof = envelope.proof_count > 0;
  const hasAuto = envelope.auto_verify != null;
  if (!hasProof && !hasAuto) return undefined;
  return {
    proofCount: hasProof ? envelope.proof_count : undefined,
    autoVerify: envelope.auto_verify,
  };
}

/**
 * trust 스트립 2주어 분화(E-VERIFY V0-S2·스푸핑불가). human_verified(+by/at)면 verified(green),
 * 아니면 self_reported면 claimed(amber·주장 단독은 green 불가), 무증거면 생략(no-fiction).
 */
function buildTrustSeal(
  envelope: HeroEnvelope | null | undefined,
  agent: HeroMember | null,
): TrustSealClaimedProps | TrustSealVerifiedProps | undefined {
  if (!envelope) return undefined;
  const { trust } = envelope;
  if (trust.human_verified && trust.human_verified_by && trust.human_verified_at) {
    return { variant: 'verified', humanName: trust.human_verified_by.name, when: formatDate(trust.human_verified_at) };
  }
  if (trust.self_reported) {
    return agent ? { variant: 'claimed', agentInitial: initials(agent.name) } : { variant: 'claimed' };
  }
  return undefined;
}

/**
 * E-GLANCE 2D hero(story dee92c96→04da0281) — 현재 에픽 **활성 story**를 `ProofCapsule density='full'`로
 * 크게 렌더(초점=크기/위계). #2099 hero envelope 소비로 리치화: claim·proofState 위에 Evidence
 * (proof_count·auto_verify)·trustSeal(claimed/verified)·Human gate(action=FE 합성) 추가.
 *
 * ⚠️ no-fiction: envelope 필드 외 발명 0(ac/risk/diff 없음·렌더 안 함). envelope null(미가용/형상붕괴)
 * 이면 리치 필드 전부 생략 → claim+state+참여자만(#2098 최소 렌더와 동일 폴백). 신뢰단계 색규율은
 * ProofCapsule/TrustSeal 토큰이 강제(주장 amber·검증 green·red는 실위반에만).
 */
export function GlanceHero({ story, memberMap, envelope }: GlanceHeroProps) {
  const t = useTranslations('glance');
  const proofState = heroProofState(story.status);
  if (!proofState) return null; // 프루프 표면 없는 상태(backlog 등) 방어 — 상위서 focal=in-progress라 정상은 통과.

  const { human, agent } = splitParticipants(story, memberMap);

  const evidence = buildEvidence(envelope);
  const trustSeal = buildTrustSeal(envelope, agent);
  const gateAction = envelope
    ? synthesizeGateAction(envelope.gate, {
        merge: t('gateActionMerge'),
        decide: t('gateActionDecide'),
        review: t('gateActionReview'),
      })
    : null;
  const gate: ProofCapsuleGate | undefined = gateAction ?? undefined;

  return (
    <div>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {t('heroLabel')}
      </p>
      <ProofCapsule
        density="full"
        proofState={proofState}
        stateLabel={t(STATE_LABEL_KEY[proofState])}
        claim={story.title}
        human={human ? { name: human.name, role: t('heroRoleHuman') } : undefined}
        agent={agent ? { name: agent.name, initial: initials(agent.name) } : undefined}
        evidence={evidence}
        trustSeal={trustSeal}
        gate={gate}
      />
    </div>
  );
}
