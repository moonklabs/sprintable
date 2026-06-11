import { describe, expect, it } from 'vitest';
import {
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
};

describe('notification-display', () => {
  it('localizes known notification labels and passes unknown types through raw', () => {
    const t = (key: string) => translations[key] ?? key;

    expect(getInboxNotificationLabel(t, 'info')).toBe('안내');
    expect(getInboxNotificationLabel(t, 'warning')).toBe('경고');
    // 837a36c4: 'memo'는 NOTIFICATION_TYPES 비포함 → switch default가 raw 타입 반환(localize 안 함).
    // 구 테스트는 존재하지 않는 filter_memo 키로 '메모'를 기대했으나, 현 계약은 unknown=raw passthrough.
    expect(getInboxNotificationLabel(t, 'memo')).toBe('memo');
  });

  it('keeps info and warning filter types available for the inbox surface', () => {
    expect(INBOX_FILTER_TYPES).toContain('info');
    expect(INBOX_FILTER_TYPES).toContain('warning');
    expect(NOTIFICATION_TYPE_ICONS.info).toBe('ℹ️');
    expect(NOTIFICATION_TYPE_ICONS.warning).toBe('⚠️');
  });

  it('includes task type in filter list and icons', () => {
    const t = (key: string) => translations[key] ?? key;

    expect(INBOX_FILTER_TYPES).toContain('task');
    expect(NOTIFICATION_TYPE_ICONS.task).toBe('📋');
    expect(getInboxNotificationLabel(t, 'task')).toBe('태스크');
  });
});
