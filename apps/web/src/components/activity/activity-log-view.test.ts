import { describe, expect, it } from 'vitest';
import { auditClaim, auditContextTooltip, type ActivityLogItem } from './activity-log-view';

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
