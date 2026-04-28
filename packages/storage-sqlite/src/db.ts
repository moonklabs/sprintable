// Uses Node.js built-in sqlite module (Node ≥ 22.5)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

let _db: DatabaseSync | null = null;

// Fixed UUIDs for OSS single-user seed — stable across restarts
export const OSS_ORG_ID = '00000000-0000-0000-0000-000000000001';
export const OSS_PROJECT_ID = '00000000-0000-0000-0000-000000000002';
export const OSS_MEMBER_ID = '00000000-0000-0000-0000-000000000003';

export function getDb(): DatabaseSync {
  if (!_db) {
    const dbPath = process.env['SQLITE_PATH'] ?? path.join(process.cwd(), 'sprintable.db');
    _db = new DatabaseSync(dbPath);
  }
  initSchema(_db);
  migrateLegacyStoryStatuses(_db);
  migrateStorySchema(_db);
  migrateEpicSchema(_db);
  migrateTeamMembersAgentIdentity(_db);
  seedOssDefaults(_db);
  return _db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epics (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'medium',
      description TEXT,
      objective TEXT,
      success_criteria TEXT,
      target_sp INTEGER,
      target_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      epic_id TEXT REFERENCES epics(id) ON DELETE SET NULL,
      sprint_id TEXT,
      assignee_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'medium',
      story_points INTEGER,
      description TEXT,
      acceptance_criteria TEXT,
      meeting_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS story_comments (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_activities (
      id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee_id TEXT,
      story_points INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    -- deleted_at column assumes fresh DB; migration story to be added when OSS ships
    CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      memo_type TEXT NOT NULL DEFAULT 'memo',
      assigned_to TEXT,
      supersedes_id TEXT,
      created_by TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS memo_replies (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      review_type TEXT NOT NULL DEFAULT 'comment',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT,
      content_format TEXT NOT NULL DEFAULT 'markdown',
      icon TEXT,
      tags TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_folder INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(project_id, slug)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      team_size INTEGER,
      velocity INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      reference_type TEXT,
      reference_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      type TEXT NOT NULL DEFAULT 'human',
      is_active INTEGER NOT NULL DEFAULT 1,
      webhook_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_story_id ON tasks(story_id);
    CREATE INDEX IF NOT EXISTS idx_memos_project_id ON memos(project_id);
    CREATE INDEX IF NOT EXISTS idx_memo_replies_memo_id ON memo_replies(memo_id);
    CREATE INDEX IF NOT EXISTS idx_docs_project_id ON docs(project_id);
    CREATE INDEX IF NOT EXISTS idx_sprints_project_id ON sprints(project_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_org_id ON team_members(org_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);

    -- ============================================================
    -- inbox_items — Operator Cockpit Phase A.1
    -- See packages/db/supabase/migrations/20260426170000_inbox_items.sql
    -- SQLite has no jsonb; origin_chain/options stored as TEXT (JSON string).
    -- Application-layer Zod validation enforces shape.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS inbox_items (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      project_id          TEXT NOT NULL,
      assignee_member_id  TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('approval','decision','blocker','mention')),
      title               TEXT NOT NULL,
      context             TEXT,
      agent_summary       TEXT,
      origin_chain        TEXT NOT NULL DEFAULT '[]',
      options             TEXT NOT NULL DEFAULT '[]',
      after_decision      TEXT,
      from_agent_id       TEXT,
      story_id            TEXT,
      memo_id             TEXT,
      priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),
      state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved','dismissed')),
      resolved_by         TEXT,
      resolved_option_id  TEXT,
      resolved_note       TEXT,
      source_type         TEXT NOT NULL CHECK (source_type IN ('agent_run','memo_mention','webhook','manual')),
      source_id           TEXT NOT NULL,
      waiting_since       TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      resolved_at         TEXT,
      UNIQUE (org_id, source_type, source_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_items_org_id      ON inbox_items(org_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_project_id  ON inbox_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_assignee    ON inbox_items(assignee_member_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_pending     ON inbox_items(state) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_inbox_items_kind        ON inbox_items(kind);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_created_at  ON inbox_items(created_at DESC);

    -- ============================================================
    -- inbox_outbox — webhook delivery queue (D6 outbox pattern)
    -- See packages/db/supabase/migrations/20260426170200_inbox_outbox.sql
    -- ============================================================
    CREATE TABLE IF NOT EXISTS inbox_outbox (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      inbox_item_id   TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL CHECK (event_type IN ('resolved','dismissed','reassigned')),
      payload         TEXT NOT NULL,
      webhook_url     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','in_flight','delivered','failed','dead')),
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_at TEXT NOT NULL,
      last_error      TEXT,
      delivered_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_outbox_inbox_item_id ON inbox_outbox(inbox_item_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_outbox_status        ON inbox_outbox(status);
    CREATE INDEX IF NOT EXISTS idx_inbox_outbox_pending_due   ON inbox_outbox(next_attempt_at)
      WHERE status IN ('pending','in_flight');

    CREATE TABLE IF NOT EXISTS standup_entries (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      sprint_id TEXT,
      author_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      done TEXT,
      plan TEXT,
      blockers TEXT,
      plan_story_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, author_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_standup_entries_project ON standup_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_standup_entries_author ON standup_entries(author_id);
    CREATE INDEX IF NOT EXISTS idx_standup_entries_date ON standup_entries(date);

    CREATE TABLE IF NOT EXISTS standup_feedback (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      sprint_id TEXT,
      standup_entry_id TEXT NOT NULL REFERENCES standup_entries(id) ON DELETE CASCADE,
      feedback_by_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
      review_type TEXT NOT NULL DEFAULT 'comment',
      feedback_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (review_type IN ('comment', 'approve', 'request_changes'))
    );

    CREATE INDEX IF NOT EXISTS idx_standup_feedback_project ON standup_feedback(project_id);
    CREATE INDEX IF NOT EXISTS idx_standup_feedback_entry ON standup_feedback(standup_entry_id);
    CREATE INDEX IF NOT EXISTS idx_standup_feedback_author ON standup_feedback(feedback_by_id);
    CREATE INDEX IF NOT EXISTS idx_standup_feedback_sprint ON standup_feedback(sprint_id);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT,
      session_id TEXT,
      memo_id TEXT,
      story_id TEXT,
      trigger TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      result_summary TEXT,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_api_keys (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT,
      expires_at TEXT,
      scope TEXT DEFAULT '["read","write"]'
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_org_project ON agent_runs(org_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_api_keys_team_member ON agent_api_keys(team_member_id);

    CREATE UNIQUE INDEX IF NOT EXISTS sprints_active_unique
      ON sprints(project_id) WHERE status = 'active' AND deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS retro_sessions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      sprint_id TEXT,
      title TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'collect',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retro_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      author_id TEXT,
      vote_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retro_votes (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(item_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS retro_actions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      assignee_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_retro_sessions_project ON retro_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_retro_items_session ON retro_items(session_id);
    CREATE INDEX IF NOT EXISTS idx_retro_actions_session ON retro_actions(session_id);
  `);
}

function migrateLegacyStoryStatuses(db: DatabaseSync): void {
  db.exec(`
    UPDATE stories SET status = 'backlog' WHERE status = 'todo';
    UPDATE stories SET status = 'in-progress' WHERE status = 'in_progress';
    UPDATE stories SET status = 'in-review' WHERE status = 'review';
  `);
}

function migrateStorySchema(db: DatabaseSync): void {
  try { db.exec(`ALTER TABLE stories ADD COLUMN acceptance_criteria TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE stories ADD COLUMN position INTEGER`); } catch { /* already exists */ }
  // position 초기값: created_at epoch * 1000
  db.exec(`UPDATE stories SET position = CAST(strftime('%s', created_at) AS INTEGER) * 1000 WHERE position IS NULL`);
  // 비표준 priority → 'medium'
  db.exec(`UPDATE stories SET priority = 'medium' WHERE priority NOT IN ('critical','high','medium','low')`);
  // 비표준 story_points → 가장 가까운 피보나치
  db.exec(`UPDATE stories SET story_points = CASE
    WHEN story_points <= 1  THEN 1
    WHEN story_points <= 2  THEN 2
    WHEN story_points <= 3  THEN 3
    WHEN story_points <= 6  THEN 5
    WHEN story_points <= 10 THEN 8
    WHEN story_points <= 17 THEN 13
    ELSE 21
  END WHERE story_points IS NOT NULL AND story_points NOT IN (1,2,3,5,8,13,21)`);
}

function migrateEpicSchema(db: DatabaseSync): void {
  // 기존 DB에 새 컬럼 추가 (없으면 추가, 이미 있으면 무시)
  const newColumns: [string, string][] = [
    ['objective', 'TEXT'],
    ['success_criteria', 'TEXT'],
    ['target_sp', 'INTEGER'],
    ['target_date', 'TEXT'],
  ];
  for (const [col, type] of newColumns) {
    try { db.exec(`ALTER TABLE epics ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
  }
  // 기존 'open' status → 'active' 정리
  db.exec(`UPDATE epics SET status = 'active' WHERE status = 'open'`);
}

// Operator Cockpit Phase A: agent identity columns on team_members
// See packages/db/supabase/migrations/20260426170100_team_members_color.sql
function migrateTeamMembersAgentIdentity(db: DatabaseSync): void {
  const newColumns: [string, string, string?][] = [
    ['color', 'TEXT', "'#3385f8'"],
    ['agent_role', 'TEXT', undefined],
  ];
  for (const [col, type, defaultValue] of newColumns) {
    const ddl = defaultValue
      ? `ALTER TABLE team_members ADD COLUMN ${col} ${type} NOT NULL DEFAULT ${defaultValue}`
      : `ALTER TABLE team_members ADD COLUMN ${col} ${type}`;
    try { db.exec(ddl); } catch { /* already exists */ }
  }
  // SQLite에는 ALTER TABLE ADD CONSTRAINT가 없음.
  // hex 검증 + agent_role 제약은 application layer (zod)에서 enforce.
}

function seedOssDefaults(db: DatabaseSync): void {
  const now = new Date().toISOString();

  db.exec(`
    INSERT OR IGNORE INTO projects (id, org_id, name, created_at, updated_at)
    VALUES (
      '${OSS_PROJECT_ID}',
      '${OSS_ORG_ID}',
      'My Project',
      '${now}',
      '${now}'
    );

    INSERT OR IGNORE INTO team_members (id, org_id, project_id, name, role, type, is_active, created_at, updated_at)
    VALUES (
      '${OSS_MEMBER_ID}',
      '${OSS_ORG_ID}',
      '${OSS_PROJECT_ID}',
      'Admin',
      'owner',
      'human',
      1,
      '${now}',
      '${now}'
    );
  `);
}
