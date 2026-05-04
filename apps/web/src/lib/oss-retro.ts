import { randomUUID } from 'crypto';

let _sqlite: typeof import('@sprintable/storage-pglite') | undefined;
async function getSqlite() {
  _sqlite ??= await import('@sprintable/storage-pglite');
  return _sqlite;
}

function toPos(q: string, p: (string|number|boolean|null)[]): [string, (string|number|boolean|null)[]] {
  let i = 0; return [q.replace(/\?/g, () => `$${++i}`), p];
}

export type RetroPhase = 'collect' | 'group' | 'vote' | 'discuss' | 'action' | 'closed';
export type RetroCategory = 'good' | 'bad' | 'improve';

export interface OssRetroSession {
  id: string;
  org_id: string;
  project_id: string;
  sprint_id: string | null;
  title: string;
  phase: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OssRetroItem {
  id: string;
  session_id: string;
  category: string;
  text: string;
  author_id: string | null;
  vote_count: number;
  created_at: string;
}

export interface OssRetroAction {
  id: string;
  session_id: string;
  title: string;
  assignee_id: string | null;
  status: string;
  created_at: string;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  collect: ['group'],
  group: ['vote'],
  vote: ['discuss'],
  discuss: ['action'],
  action: ['closed'],
};

function now() {
  return new Date().toISOString();
}

export async function listOssRetroSessions(projectId: string): Promise<OssRetroSession[]> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  return (await db.query(...toPos('SELECT * FROM retro_sessions WHERE project_id = ? ORDER BY created_at DESC', [projectId]))).rows as unknown as OssRetroSession[];
}

export async function getOssRetroSession(sessionId: string, projectId: string): Promise<OssRetroSession | null> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  return (await db.query(...toPos('SELECT * FROM retro_sessions WHERE id = ? AND project_id = ?', [sessionId, projectId]))).rows[0] as unknown as OssRetroSession ?? null;
}

export async function createOssRetroSession(input: {
  org_id: string;
  project_id: string;
  title: string;
  sprint_id?: string | null;
  created_by?: string | null;
}): Promise<OssRetroSession> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const id = randomUUID();
  const ts = now();
  await db.query(...toPos(
    'INSERT INTO retro_sessions (id, org_id, project_id, sprint_id, title, phase, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.org_id, input.project_id, input.sprint_id ?? null, input.title, 'collect', input.created_by ?? null, ts, ts]
  ));
  return (await getOssRetroSession(id, input.project_id))!;
}

export async function advanceOssRetroPhase(sessionId: string, projectId: string, phase: RetroPhase): Promise<OssRetroSession> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const session = await getOssRetroSession(sessionId, projectId);
  if (!session) throw new Error('Session not found');
  if (!VALID_TRANSITIONS[session.phase]?.includes(phase)) {
    throw new Error(`Invalid transition: ${session.phase} → ${phase}`);
  }
  const ts = now();
  await db.query(...toPos('UPDATE retro_sessions SET phase = ?, updated_at = ? WHERE id = ?', [phase, ts, sessionId]));
  return (await getOssRetroSession(sessionId, projectId))!;
}

export async function listOssRetroItems(sessionId: string, projectId: string): Promise<OssRetroItem[]> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const session = await getOssRetroSession(sessionId, projectId);
  if (!session) return [];
  return (await db.query(...toPos('SELECT * FROM retro_items WHERE session_id = ? ORDER BY created_at ASC', [sessionId]))).rows as unknown as OssRetroItem[];
}

export async function addOssRetroItem(input: {
  session_id: string;
  project_id: string;
  category: RetroCategory;
  text: string;
  author_id: string;
}): Promise<OssRetroItem> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const session = await getOssRetroSession(input.session_id, input.project_id);
  if (!session) throw new Error('Session not in project');
  const id = randomUUID();
  const ts = now();
  await db.query(...toPos(
    'INSERT INTO retro_items (id, session_id, category, text, author_id, vote_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [id, input.session_id, input.category, input.text, input.author_id, ts]
  ));
  return (await db.query(...toPos('SELECT * FROM retro_items WHERE id = ?', [id]))).rows[0] as unknown as OssRetroItem;
}

export async function voteOssRetroItem(itemId: string, voterId: string, projectId: string): Promise<{ voted: boolean }> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const item = (await db.query(...toPos('SELECT session_id FROM retro_items WHERE id = ?', [itemId]))).rows[0] as { session_id: string } | null;
  if (!item) throw new Error('Item not found');
  const session = await getOssRetroSession(item.session_id, projectId);
  if (!session) throw new Error('Item not in project');
  try {
    await db.query(...toPos(
      'INSERT INTO retro_votes (id, item_id, voter_id, created_at) VALUES (?, ?, ?, ?)',
      [randomUUID(), itemId, voterId, now()]
    ));
    await db.query(...toPos('UPDATE retro_items SET vote_count = vote_count + 1 WHERE id = ?', [itemId]));
    return { voted: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') || msg.includes('duplicate key')) {
      throw Object.assign(new Error('Already voted on this item'), { code: 'CONFLICT' });
    }
    throw err;
  }
}

export async function listOssRetroActions(sessionId: string, projectId: string): Promise<OssRetroAction[]> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const session = await getOssRetroSession(sessionId, projectId);
  if (!session) return [];
  return (await db.query(...toPos('SELECT * FROM retro_actions WHERE session_id = ? ORDER BY created_at ASC', [sessionId]))).rows as unknown as OssRetroAction[];
}

export async function addOssRetroAction(input: {
  session_id: string;
  project_id: string;
  title: string;
  assignee_id?: string | null;
}): Promise<OssRetroAction> {
  const { getDb } = await getSqlite();
  const db = await getDb();
  const session = await getOssRetroSession(input.session_id, input.project_id);
  if (!session) throw new Error('Session not in project');
  const id = randomUUID();
  const ts = now();
  await db.query(...toPos(
    'INSERT INTO retro_actions (id, session_id, title, assignee_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.session_id, input.title, input.assignee_id ?? null, 'open', ts]
  ));
  return (await db.query(...toPos('SELECT * FROM retro_actions WHERE id = ?', [id]))).rows[0] as unknown as OssRetroAction;
}
