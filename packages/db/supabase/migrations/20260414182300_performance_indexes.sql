-- E-034:S11 — Performance optimization indexes
-- Adds composite indexes for common query patterns to prevent 504 timeouts

-- ============================================================
-- 1. Notifications composite index for common filter pattern
-- ============================================================
-- Pattern: user_id + is_read + type + created_at (most common query in /api/notifications)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_read_type_created
  ON public.notifications(user_id, is_read, type, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_notifications_user_read_type_created IS
  'Composite index for notifications list query with user filter, read status, and type';

-- ============================================================
-- 2. Stories composite index for kanban board queries
-- ============================================================
-- Pattern: project_id + sprint_id + status (board filtering)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stories_project_sprint_status
  ON public.stories(project_id, sprint_id, status)
  WHERE deleted_at IS NULL;

-- Pattern: project_id + epic_id + status (epic board filtering)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stories_project_epic_status
  ON public.stories(project_id, epic_id, status)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_stories_project_sprint_status IS
  'Composite index for kanban board filtering by sprint';

COMMENT ON INDEX idx_stories_project_epic_status IS
  'Composite index for kanban board filtering by epic';

-- ============================================================
-- 3. Memos composite index for list queries with filters
-- ============================================================
-- Pattern: project_id + status + updated_at (most common memos list query)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memos_project_status_updated
  ON public.memos(project_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_memos_project_status_updated IS
  'Composite index for memos list with status filter and cursor pagination';

-- ============================================================
-- 4. Tasks composite index for story detail queries
-- ============================================================
-- Pattern: story_id + status + created_at (task list in story detail panel)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_story_status_created
  ON public.tasks(story_id, status, created_at ASC)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_tasks_story_status_created IS
  'Composite index for task list in story detail panel';
