import { randomUUID } from 'crypto';

let _sqlite: typeof import('@sprintable/storage-sqlite') | undefined;
async function getSqlite() {
  _sqlite ??= await import('@sprintable/storage-sqlite');
  return _sqlite;
}

type StandupReviewType = 'comment' | 'approve' | 'request_changes';

interface StandupEntryRow {
  id: string;
  org_id: string;
  project_id: string;
  sprint_id: string | null;
  author_id: string;
  date: string;
  done: string | null;
  plan: string | null;
  blockers: string | null;
  plan_story_ids: string[];
  created_at: string;
  updated_at: string;
}

interface StandupFeedbackRow {
  id: string;
  org_id: string;
  project_id: string;
  sprint_id: string | null;
  standup_entry_id: string;
  feedback_by_id: string;
  review_type: StandupReviewType;
  feedback_text: string;
  created_at: string;
  updated_at: string;
}

function parseStoryIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeEntry(row: Record<string, unknown>): StandupEntryRow {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    project_id: String(row.project_id),
    sprint_id: row.sprint_id ? String(row.sprint_id) : null,
    author_id: String(row.author_id),
    date: String(row.date),
    done: row.done ? String(row.done) : null,
    plan: row.plan ? String(row.plan) : null,
    blockers: row.blockers ? String(row.blockers) : null,
    plan_story_ids: parseStoryIds(row.plan_story_ids),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function normalizeFeedback(row: Record<string, unknown>): StandupFeedbackRow {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    project_id: String(row.project_id),
    sprint_id: row.sprint_id ? String(row.sprint_id) : null,
    standup_entry_id: String(row.standup_entry_id),
    feedback_by_id: String(row.feedback_by_id),
    review_type: String(row.review_type) as StandupReviewType,
    feedback_text: String(row.feedback_text),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function listOssStandupEntries(projectId: string, date: string): Promise<StandupEntryRow[]> {
  const { getDb } = await getSqlite();
  const rows = getDb()
    .prepare(`
      SELECT *
      FROM standup_entries
      WHERE project_id = ? AND date = ?
      ORDER BY created_at
    `)
    .all(projectId, date) as Array<Record<string, unknown>>;

  return rows.map(normalizeEntry);
}

export async function getOssStandupEntryForUser(projectId: string, authorId: string, date: string): Promise<StandupEntryRow | null> {
  const { getDb } = await getSqlite();
  const row = getDb()
    .prepare(`
      SELECT *
      FROM standup_entries
      WHERE project_id = ? AND author_id = ? AND date = ?
      LIMIT 1
    `)
    .get(projectId, authorId, date) as Record<string, unknown> | undefined;

  return row ? normalizeEntry(row) : null;
}

export async function saveOssStandupEntry(input: {
  project_id: string;
  org_id: string;
  sprint_id?: string | null;
  author_id: string;
  date: string;
  done: string | null;
  plan: string | null;
  blockers: string | null;
  plan_story_ids?: string[];
}): Promise<StandupEntryRow> {
  const { getDb } = await getSqlite();
  const now = new Date().toISOString();
  const id = randomUUID();

  getDb().prepare(`
    INSERT INTO standup_entries (
      id, org_id, project_id, sprint_id, author_id, date, done, plan, blockers, plan_story_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, author_id, date) DO UPDATE SET
      sprint_id = excluded.sprint_id,
      done = excluded.done,
      plan = excluded.plan,
      blockers = excluded.blockers,
      plan_story_ids = excluded.plan_story_ids,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.org_id,
    input.project_id,
    input.sprint_id ?? null,
    input.author_id,
    input.date,
    input.done,
    input.plan,
    input.blockers,
    JSON.stringify(input.plan_story_ids ?? []),
    now,
    now,
  );

  return (await getOssStandupEntryForUser(input.project_id, input.author_id, input.date))!;
}

export async function getOssStandupMissing(projectId: string, date: string) {
  const { getDb } = await getSqlite();
  const db = getDb();
  const members = db.prepare(`
    SELECT id, name
    FROM team_members
    WHERE project_id = ? AND is_active = 1
  `).all(projectId) as Array<{ id: string; name: string }>;

  const entries = db.prepare(`
    SELECT author_id
    FROM standup_entries
    WHERE project_id = ? AND date = ?
  `).all(projectId, date) as Array<{ author_id: string }>;

  const submitted = new Set(entries.map((entry) => entry.author_id));
  const missing = members.filter((member) => !submitted.has(member.id));

  return {
    submitted_count: submitted.size,
    missing,
  };
}

export async function getOssStandupHistory(projectId: string, limit = 50) {
  const { getDb } = await getSqlite();
  return getDb().prepare(`
    SELECT author_id, date, done, plan, blockers
    FROM standup_entries
    WHERE project_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(projectId, limit) as Array<Record<string, unknown>>;
}

export async function listOssStandupFeedbackByDate(projectId: string, date: string): Promise<StandupFeedbackRow[]> {
  const { getDb } = await getSqlite();
  const rows = getDb().prepare(`
    SELECT sf.*
    FROM standup_feedback sf
    INNER JOIN standup_entries se ON se.id = sf.standup_entry_id
    WHERE se.project_id = ? AND se.date = ?
    ORDER BY sf.created_at
  `).all(projectId, date) as Array<Record<string, unknown>>;

  return rows.map(normalizeFeedback);
}

export async function listOssStandupFeedbackForEntry(entryId: string): Promise<StandupFeedbackRow[]> {
  const { getDb } = await getSqlite();
  const rows = getDb().prepare(`
    SELECT *
    FROM standup_feedback
    WHERE standup_entry_id = ?
    ORDER BY created_at
  `).all(entryId) as Array<Record<string, unknown>>;

  return rows.map(normalizeFeedback);
}

export async function getOssStandupFeedback(id: string): Promise<StandupFeedbackRow | null> {
  const { getDb } = await getSqlite();
  const row = getDb().prepare(`
    SELECT *
    FROM standup_feedback
    WHERE id = ?
    LIMIT 1
  `).get(id) as Record<string, unknown> | undefined;

  return row ? normalizeFeedback(row) : null;
}

export async function createOssStandupFeedback(input: {
  project_id: string;
  org_id: string;
  standup_entry_id: string;
  feedback_by_id: string;
  review_type?: StandupReviewType;
  feedback_text: string;
}): Promise<StandupFeedbackRow> {
  const { getDb } = await getSqlite();
  const db = getDb();
  const entry = db.prepare(`
    SELECT sprint_id
    FROM standup_entries
    WHERE id = ?
    LIMIT 1
  `).get(input.standup_entry_id) as { sprint_id?: string | null } | undefined;

  if (!entry) {
    throw new Error('Standup entry not found');
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO standup_feedback (
      id, org_id, project_id, sprint_id, standup_entry_id, feedback_by_id, review_type, feedback_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.org_id,
    input.project_id,
    entry.sprint_id ?? null,
    input.standup_entry_id,
    input.feedback_by_id,
    input.review_type ?? 'comment',
    input.feedback_text,
    now,
    now,
  );

  return (await getOssStandupFeedback(id))!;
}

export async function updateOssStandupFeedback(
  id: string,
  input: { review_type?: StandupReviewType; feedback_text?: string },
  actorId: string,
): Promise<StandupFeedbackRow> {
  const { getDb } = await getSqlite();
  const current = await getOssStandupFeedback(id);
  if (!current) throw new Error('Standup feedback not found');
  if (current.feedback_by_id !== actorId) throw new Error('Only the feedback author can update this entry');

  const nextReviewType = input.review_type ?? current.review_type;
  const nextText = input.feedback_text ?? current.feedback_text;

  getDb().prepare(`
    UPDATE standup_feedback
    SET review_type = ?, feedback_text = ?, updated_at = ?
    WHERE id = ?
  `).run(nextReviewType, nextText, new Date().toISOString(), id);

  return (await getOssStandupFeedback(id))!;
}

export async function deleteOssStandupFeedback(id: string, actorId: string): Promise<void> {
  const { getDb } = await getSqlite();
  const current = await getOssStandupFeedback(id);
  if (!current) throw new Error('Standup feedback not found');
  if (current.feedback_by_id !== actorId) throw new Error('Only the feedback author can delete this entry');

  getDb().prepare(`
    DELETE FROM standup_feedback
    WHERE id = ?
  `).run(id);
}
