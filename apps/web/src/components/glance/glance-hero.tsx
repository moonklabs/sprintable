'use client';

import { useTranslations } from 'next-intl';
import { ProofCapsule, type ProofState } from '@/components/proof-capsule/proof-capsule';
import { initials } from '@/lib/storage/format';
import { heroProofState, splitParticipants, type HeroStory, type HeroMember } from './hero-logic';

interface GlanceHeroProps {
  story: HeroStory;
  memberMap: Record<string, HeroMember>;
}

const STATE_LABEL_KEY: Record<ProofState, string> = {
  blue: 'heroStateInProgress',
  amber: 'heroStateReviewing',
  green: 'heroStateProven',
  red: 'heroStateViolation',
};

/**
 * E-GLANCE 2D hero(story dee92c96) — 현재 에픽의 **활성 story**를 기존 `ProofCapsule density='full'`로
 * 크게 렌더(초점=크기/위계). claim=story.title·proofState=status·human/agent=assignee type 분리.
 *
 * ⚠️ no-fiction: 에픽엔 evidence/gate 소스가 없고 story acMet/autoVerify/diff도 실 BE 소스가 없다
 * (StoryDetailPanel도 `evidence={null}`). 그래서 evidence/gate를 **넘기지 않는다** → ProofCapsule은
 * claim+state+참여자만 렌더(= "아직 증거 없음" 정직 최소). 발명 0.
 */
export function GlanceHero({ story, memberMap }: GlanceHeroProps) {
  const t = useTranslations('glance');
  const proofState = heroProofState(story.status);
  if (!proofState) return null; // 프루프 표면 없는 상태(backlog 등) 방어 — 상위서 focal=in-progress라 정상은 통과.

  const { human, agent } = splitParticipants(story, memberMap);

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
      />
    </div>
  );
}
