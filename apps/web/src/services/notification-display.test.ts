import { describe, expect, it } from 'vitest';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';
import {
  getEventTypeCopy,
  getInboxNotificationLabel,
  INBOX_FILTER_TYPES,
  NOTIFICATION_TYPE_ICONS,
} from './notification-display';

const translations: Record<string, string> = {
  filter_story: '스토리',
  filter_task: '태스크',
  filter_reward: '리워드',
  filter_info: '안내',
  filter_warning: '경고',
  filter_system: '시스템',
  filter_gate_pending_approval: '게이트 결재 대기',
  filter_generic: '알림',
  eventMention: '새 멘션',
  eventMessage: '새 메시지',
};

describe('notification-display', () => {
  it('localizes known notification labels and localizes unknown types to a generic fallback', () => {
    const t = (key: string) => translations[key] ?? key;

    expect(getInboxNotificationLabel(t, 'info')).toBe('안내');
    expect(getInboxNotificationLabel(t, 'warning')).toBe('경고');
    // story #4316 CHANGES2(PO 라이브 실측 2026-09-15) — 상세 패널 타입 배지가 미상 type을
    // raw로 노출하던 결함(gate.pending_approval 실측)을 닫음: switch default가 이제
    // raw passthrough가 아니라 filter_generic(일반 라벨)로 떨어진다.
    expect(getInboxNotificationLabel(t, 'memo')).toBe('알림');
  });

  it('localizes conversation.mention·conversation.message·gate.pending_approval(story #4316 CHANGES2, raw slug 노출 회귀가드)', () => {
    const t = (key: string) => translations[key] ?? key;

    expect(getInboxNotificationLabel(t, 'conversation.mention')).toBe('새 멘션');
    expect(getInboxNotificationLabel(t, 'conversation.message')).toBe('새 메시지');
    expect(getInboxNotificationLabel(t, 'gate.pending_approval')).toBe('게이트 결재 대기');
  });

  it('keeps info and warning filter types available for the inbox surface', () => {
    expect(INBOX_FILTER_TYPES).toContain('info');
    expect(INBOX_FILTER_TYPES).toContain('warning');
    // 글리프→lucide 변환(컴포넌트 맵): 키별 아이콘 컴포넌트 존재 확認(emoji 문자열 단언 폐기).
    expect(NOTIFICATION_TYPE_ICONS.info).toBeTruthy();
    expect(NOTIFICATION_TYPE_ICONS.warning).toBeTruthy();
  });

  it('includes task type in filter list and icons', () => {
    const t = (key: string) => translations[key] ?? key;

    expect(INBOX_FILTER_TYPES).toContain('task');
    expect(NOTIFICATION_TYPE_ICONS.task).toBeTruthy();
    expect(getInboxNotificationLabel(t, 'task')).toBe('태스크');
  });
});

describe('getEventTypeCopy', () => {
  // e2608901: 카피 매핑은 i18n 키를 반환 — 테스트는 키 식별로 검증(번역값 비결합).
  const t = (key: string) => key;

  it('maps raw dotted/colon event_type to human copy keys (raw never exposed)', () => {
    expect(getEventTypeCopy(t, 'conversation.message_created')).toBe('eventMessage');
    expect(getEventTypeCopy(t, 'message.created')).toBe('eventMessage');
    expect(getEventTypeCopy(t, 'conversation:mention')).toBe('eventMention');
    expect(getEventTypeCopy(t, 'story.status_changed')).toBe('eventStoryStatus');
    expect(getEventTypeCopy(t, 'story.assignee_changed')).toBe('eventStoryAssignee');
  });

  it('maps underscore/semantic legacy event_types', () => {
    expect(getEventTypeCopy(t, 'story_assigned')).toBe('eventStoryAssigned');
    expect(getEventTypeCopy(t, 'task_completed')).toBe('eventTaskCompleted');
    expect(getEventTypeCopy(t, 'sprint_closed')).toBe('eventSprintClosed');
    expect(getEventTypeCopy(t, 'agent_joined')).toBe('eventAgentJoined');
    expect(getEventTypeCopy(t, 'dispatched')).toBe('eventDispatched');
  });

  it('absorbs unknown event_types via domain prefix, never returning raw', () => {
    expect(getEventTypeCopy(t, 'agent_deployment.terminated')).toBe('eventAgentDeployment');
    expect(getEventTypeCopy(t, 'story.something_new')).toBe('eventStory');
    expect(getEventTypeCopy(t, 'task.brand_new')).toBe('eventTask');
    expect(getEventTypeCopy(t, 'doc.commented')).toBe('eventDoc');
  });

  it('falls back to generic copy for entirely unknown or empty event_type (AC① raw 0)', () => {
    expect(getEventTypeCopy(t, 'totally_unknown_event')).toBe('eventFallback');
    expect(getEventTypeCopy(t, '')).toBe('eventFallback');
    expect(getEventTypeCopy(t, null)).toBe('eventFallback');
    expect(getEventTypeCopy(t, undefined)).toBe('eventFallback');
    // 어떤 입력도 raw event_type 문자열을 그대로 반환하지 않는다.
    expect(getEventTypeCopy(t, 'totally_unknown_event')).not.toBe('totally_unknown_event');
  });

  it('every copy key getEventTypeCopy can emit exists in en & ko (AC④ — no missing-key at runtime)', () => {
    // 직접 매핑 + prefix 폴백 + generic이 낼 수 있는 모든 키를 수집 — i18n 누락 시 런타임에서 raw key 노출.
    const keyCollector = (key: string) => key;
    const emittedKeys = new Set<string>();
    const samples = [
      'conversation.message_created', 'message.created', 'conversation:mention',
      'story.status_changed', 'story.assignee_changed', 'story_assigned', 'story',
      'task_assigned', 'task_completed', 'task', 'sprint_closed', 'agent_joined',
      'dispatched', 'standup_reminder', 'invitation', 'reward', 'warning', 'system', 'info',
      'agent_deployment.terminated', 'doc.commented', 'unknown_event', '',
    ];
    for (const s of samples) emittedKeys.add(getEventTypeCopy(keyCollector, s));

    const enInbox = (enMessages as { inbox: Record<string, string> }).inbox;
    const koInbox = (koMessages as { inbox: Record<string, string> }).inbox;
    for (const key of emittedKeys) {
      expect(enInbox[key], `en.json inbox.${key} missing`).toBeTypeOf('string');
      expect(koInbox[key], `ko.json inbox.${key} missing`).toBeTypeOf('string');
    }
  });
});
