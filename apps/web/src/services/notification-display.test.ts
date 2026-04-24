import { describe, expect, it } from 'vitest';
import {
  getInboxNotificationLabel,
  INBOX_FILTER_TYPES,
  NOTIFICATION_TYPE_ICONS,
} from './notification-display';

const translations: Record<string, string> = {
  filter_story: '스토리',
  filter_memo: '메모',
  filter_task: '태스크',
  filter_reward: '리워드',
  filter_info: '안내',
  filter_warning: '경고',
  filter_system: '시스템',
};

describe('notification-display', () => {
  it('localizes info and warning notification labels', () => {
    const t = (key: string) => translations[key] ?? key;

    expect(getInboxNotificationLabel(t, 'info')).toBe('안내');
    expect(getInboxNotificationLabel(t, 'warning')).toBe('경고');
    expect(getInboxNotificationLabel(t, 'memo')).toBe('메모');
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
