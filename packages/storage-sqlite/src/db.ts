// Uses Node.js built-in sqlite module (Node ≥ 22.5)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    const dbPath = process.env['SQLITE_PATH'] ?? path.join(process.cwd(), 'sprintable.db');
    _db = new DatabaseSync(dbPath);
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epics (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      description TEXT,
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
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      story_points INTEGER,
      description TEXT,
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
  `);
}
