import { randomUUID } from 'node:crypto';
import { getDb } from '@sprintable/storage-sqlite';

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

export function listOssRetroSessions(projectId: string): OssRetroSession[] {
  return getDb()
    .prepare('SELECT * FROM retro_sessions WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as unknown as unknown as OssRetroSession[];
}

export function getOssRetroSession(sessionId: string, projectId: string): OssRetroSession | null {
  return (getDb()
    .prepare('SELECT * FROM retro_sessions WHERE id = ? AND project_id = ?')
    .get(sessionId, projectId) as unknown as OssRetroSession) ?? null;
}

export function createOssRetroSession(input: {
  org_id: string;
  project_id: string;
  title: string;
  sprint_id?: string | null;
  created_by?: string | null;
}): OssRetroSession {
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare(
      'INSERT INTO retro_sessions (id, org_id, project_id, sprint_id, title, phase, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, input.org_id, input.project_id, input.sprint_id ?? null, input.title, 'collect', input.created_by ?? null, ts, ts);
  return getOssRetroSession(id, input.project_id)!;
}

export function advanceOssRetroPhase(sessionId: string, projectId: string, phase: RetroPhase): OssRetroSession {
  const session = getOssRetroSession(sessionId, projectId);
  if (!session) throw new Error('Session not found');
  if (!VALID_TRANSITIONS[session.phase]?.includes(phase)) {
    throw new Error(`Invalid transition: ${session.phase} → ${phase}`);
  }
  const ts = now();
  getDb()
    .prepare('UPDATE retro_sessions SET phase = ?, updated_at = ? WHERE id = ?')
    .run(phase, ts, sessionId);
  return getOssRetroSession(sessionId, projectId)!;
}

export function listOssRetroItems(sessionId: string, projectId: string): OssRetroItem[] {
  const session = getOssRetroSession(sessionId, projectId);
  if (!session) return [];
  return getDb()
    .prepare('SELECT * FROM retro_items WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as unknown as unknown as OssRetroItem[];
}

export function addOssRetroItem(input: {
  session_id: string;
  project_id: string;
  category: RetroCategory;
  text: string;
  author_id: string;
}): OssRetroItem {
  const session = getOssRetroSession(input.session_id, input.project_id);
  if (!session) throw new Error('Session not in project');
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare('INSERT INTO retro_items (id, session_id, category, text, author_id, vote_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(id, input.session_id, input.category, input.text, input.author_id, ts);
  return getDb().prepare('SELECT * FROM retro_items WHERE id = ?').get(id) as unknown as OssRetroItem;
}

export function voteOssRetroItem(itemId: string, voterId: string, projectId: string): { voted: boolean } {
  const item = getDb().prepare('SELECT session_id FROM retro_items WHERE id = ?').get(itemId) as { session_id: string } | null;
  if (!item) throw new Error('Item not found');
  const session = getOssRetroSession(item.session_id, projectId);
  if (!session) throw new Error('Item not in project');
  try {
    getDb()
      .prepare('INSERT INTO retro_votes (id, item_id, voter_id, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), itemId, voterId, now());
    getDb()
      .prepare('UPDATE retro_items SET vote_count = vote_count + 1 WHERE id = ?')
      .run(itemId);
    return { voted: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE')) {
      throw Object.assign(new Error('Already voted on this item'), { code: 'CONFLICT' });
    }
    throw err;
  }
}

export function listOssRetroActions(sessionId: string, projectId: string): OssRetroAction[] {
  const session = getOssRetroSession(sessionId, projectId);
  if (!session) return [];
  return getDb()
    .prepare('SELECT * FROM retro_actions WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as unknown as unknown as OssRetroAction[];
}

export function addOssRetroAction(input: {
  session_id: string;
  project_id: string;
  title: string;
  assignee_id?: string | null;
}): OssRetroAction {
  const session = getOssRetroSession(input.session_id, input.project_id);
  if (!session) throw new Error('Session not in project');
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare('INSERT INTO retro_actions (id, session_id, title, assignee_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.session_id, input.title, input.assignee_id ?? null, 'open', ts);
  return getDb().prepare('SELECT * FROM retro_actions WHERE id = ?').get(id) as unknown as OssRetroAction;
}
