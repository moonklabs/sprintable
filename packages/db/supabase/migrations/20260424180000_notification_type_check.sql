-- Add CHECK constraint on notifications.type
-- Valid types: legacy semantic + action-specific (Phase 4)
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN (
      'memo', 'story', 'task', 'reward', 'info', 'warning', 'system', 'standup_reminder',
      'story_assigned', 'memo_reply', 'memo_mention',
      'task_assigned', 'task_completed', 'sprint_closed', 'invitation'
    )
  );
