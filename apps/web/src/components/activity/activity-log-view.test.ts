import { describe, expect, it } from 'vitest';
import { auditActorProps, auditClaim, auditContextTooltip, type ActivityLogItem } from './activity-log-view';

function item(overrides: Partial<ActivityLogItem> = {}): ActivityLogItem {
  return {
    id: 'log-1',
    project_id: 'proj-1',
    actor_id: null,
    actor_name: null,
    actor_type: null,
    action: 'story.status_changed',
    entity_type: null,
    entity_id: null,
    entity_title: null,
    context: null,
    created_at: '2026-07-09T12:00:00Z',
    ...overrides,
  };
}

describe('auditClaim (no-fiction — entity_title/entity_type가 nullable인 실 BE 스키마 그대로)', () => {
  it('prefers "entity_type · entity_title" when both are present', () => {
    expect(auditClaim(item({ entity_type: 'story', entity_title: '결제 복구 플로우' }))).toBe('story · 결제 복구 플로우');
  });

  it('falls back to entity_title alone when entity_type is null', () => {
    expect(auditClaim(item({ entity_type: null, entity_title: '결제 복구 플로우' }))).toBe('결제 복구 플로우');
  });

  it('falls back to the raw action when both entity fields are null (never invents a title)', () => {
    expect(auditClaim(item({ entity_type: null, entity_title: null, action: 'gate.rejected' }))).toBe('gate.rejected');
  });
});

describe('auditContextTooltip (context 필드는 native title로 보존, 요약이 아니라 원문)', () => {
  it('always includes the action even with no context', () => {
    expect(auditContextTooltip(item({ action: 'story.claimed', context: null }))).toBe('action: story.claimed');
  });

  it('appends every context key/value on its own line', () => {
    const tooltip = auditContextTooltip(item({ action: 'gate.rejected', context: { risk: '높음', reason: '충돌' } }));
    expect(tooltip).toBe('action: gate.rejected\nrisk: 높음\nreason: 충돌');
  });

  it('handles an empty context object without leaking "undefined" or extra lines', () => {
    expect(auditContextTooltip(item({ action: 'memo.viewed', context: {} }))).toBe('action: memo.viewed');
  });
});

// story #2923(P0-E AQ4, 그라운딩 발견) — 예전엔 actor_type 무관하게 항상 human prop으로만
// 넘겨(agent 미사용) 시안의 "아바타 shape로 human/agent 구분"이 안 걸렸다. actor_type이
// 'agent'일 때만 agent 경로, 그 외(human·null=미상)는 human 경로(보수적 기본값).
describe('auditActorProps (story #2923 AQ4 — actor_type을 human/agent prop으로 정확히 갈라 넘긴다)', () => {
  it('routes actor_type=agent through the agent prop, not human', () => {
    const props = auditActorProps(item({ actor_name: '미르코', actor_type: 'agent' }));
    expect(props.agent).toEqual({ name: '미르코', initial: '미' });
    expect(props.human).toBeUndefined();
  });

  it('routes actor_type=human through the human prop, not agent', () => {
    const props = auditActorProps(item({ actor_name: '송윤재', actor_type: 'human' }));
    expect(props.human).toEqual({ name: '송윤재', role: 'human' });
    expect(props.agent).toBeUndefined();
  });

  it('actor_type=null(미상)은 보수적으로 human 경로로 폴백한다(storage-uploader-avatar.tsx 선례와 동형)', () => {
    const props = auditActorProps(item({ actor_name: '알수없음', actor_type: null }));
    expect(props.human).toEqual({ name: '알수없음', role: 'human' });
    expect(props.agent).toBeUndefined();
  });

  it('actor_name이 없으면(null) human/agent 둘 다 비운다(지어내지 않음)', () => {
    const props = auditActorProps(item({ actor_name: null, actor_type: 'agent' }));
    expect(props.human).toBeUndefined();
    expect(props.agent).toBeUndefined();
  });
});
