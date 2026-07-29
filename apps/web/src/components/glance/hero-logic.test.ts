import { describe, expect, it } from 'vitest';
import { heroProofState, splitParticipants, type HeroStory, type HeroMember } from './hero-logic';

const story = (id: string, status: string, extra: Partial<HeroStory> = {}): HeroStory => ({
  id, title: `S-${id}`, status, assignee_id: null, ...extra,
});

describe('heroProofState (story.status → ProofState·정본 매핑)', () => {
  it('in-progress→blue·in-review→amber·done→green', () => {
    expect(heroProofState('in-progress')).toBe('blue');
    expect(heroProofState('in-review')).toBe('amber');
    expect(heroProofState('done')).toBe('green');
  });
  it('프루프 표면 없는 상태(backlog/ready-for-dev)→null', () => {
    expect(heroProofState('backlog')).toBeNull();
    expect(heroProofState('ready-for-dev')).toBeNull();
  });
});

describe('splitParticipants (human/agent 분리·memberMap type 기준)', () => {
  const mm: Record<string, HeroMember> = {
    h1: { name: '윤재', type: 'human' },
    a1: { name: '미르코', type: 'agent' },
  };

  it('assignee_ids에서 human/agent 각각 분리', () => {
    const { human, agent } = splitParticipants(story('s', 'in-progress', { assignee_ids: ['h1', 'a1'] }), mm);
    expect(human?.name).toBe('윤재');
    expect(agent?.name).toBe('미르코');
  });

  it('assignee_ids 없으면 단일 assignee_id 폴백', () => {
    const { human, agent } = splitParticipants(story('s', 'in-progress', { assignee_id: 'a1' }), mm);
    expect(human).toBeNull();
    expect(agent?.name).toBe('미르코');
  });

  it('매핑 없는 id는 무시(발명 0)', () => {
    const { human, agent } = splitParticipants(story('s', 'in-progress', { assignee_ids: ['ghost'] }), mm);
    expect(human).toBeNull();
    expect(agent).toBeNull();
  });
});
