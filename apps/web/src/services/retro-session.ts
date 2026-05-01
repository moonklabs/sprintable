

export type RetroSessionPhase = 'collect' | 'group' | 'vote' | 'discuss' | 'action' | 'closed';
export type RetroItemCategory = 'good' | 'bad' | 'improve';

export interface RetroSessionRecord {
  id: string;
  org_id: string;
  project_id: string;
  sprint_id: string | null;
  title: string;
  phase: string;
  created_by: string;
  created_at: string;
}

export interface RetroItemRecord {
  id: string;
  session_id: string;
  category: string;
  text: string;
  vote_count: number;
  author_id: string;
  created_at: string;
}

export interface RetroActionRecord {
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

export class RetroSessionService {
  constructor(private readonly db: any) {}

  async getSession(sessionId: string, projectId: string): Promise<RetroSessionRecord | null> {
    const { data, error } = await this.db
      .from('retro_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('project_id', projectId)
      .single();
    if (error) return null;
    return data as RetroSessionRecord;
  }

  async listItems(sessionId: string, projectId: string): Promise<RetroItemRecord[]> {
    const { data: sess } = await this.db
      .from('retro_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('project_id', projectId)
      .single();
    if (!sess) throw new Error('Session not in project');
    const { data, error } = await this.db
      .from('retro_items')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at');
    if (error) throw error;
    return (data ?? []) as RetroItemRecord[];
  }

  async listActions(sessionId: string, projectId: string): Promise<RetroActionRecord[]> {
    const { data: sess } = await this.db
      .from('retro_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('project_id', projectId)
      .single();
    if (!sess) throw new Error('Session not in project');
    const { data, error } = await this.db
      .from('retro_actions')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at');
    if (error) throw error;
    return (data ?? []) as RetroActionRecord[];
  }

  async listSessions(projectId: string): Promise<RetroSessionRecord[]> {
    const { data, error } = await this.db
      .from('retro_sessions')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as RetroSessionRecord[];
  }

  async createSession(input: {
    org_id: string;
    project_id: string;
    title: string;
    sprint_id?: string | null;
    created_by: string;
  }): Promise<RetroSessionRecord> {
    const { data, error } = await this.db
      .from('retro_sessions')
      .insert(input)
      .select()
      .single();
    if (error) throw error;
    return data as RetroSessionRecord;
  }

  async changePhase(sessionId: string, projectId: string, phase: RetroSessionPhase): Promise<RetroSessionRecord> {
    const { data: session, error: fetchErr } = await this.db
      .from('retro_sessions')
      .select('phase')
      .eq('id', sessionId)
      .eq('project_id', projectId)
      .single();
    if (fetchErr || !session) throw new Error('Session not found');
    const current = session.phase as string;
    if (!VALID_TRANSITIONS[current]?.includes(phase)) {
      throw new Error(`Invalid transition: ${current} → ${phase}`);
    }
    const { data, error } = await this.db
      .from('retro_sessions')
      .update({ phase })
      .eq('id', sessionId)
      .select()
      .single();
    if (error) throw error;
    return data as RetroSessionRecord;
  }

  async addItem(input: {
    session_id: string;
    project_id: string;
    category: RetroItemCategory;
    text: string;
    author_id: string;
  }): Promise<RetroItemRecord> {
    const { data: sess, error: sessErr } = await this.db
      .from('retro_sessions')
      .select('id')
      .eq('id', input.session_id)
      .eq('project_id', input.project_id)
      .single();
    if (sessErr || !sess) throw new Error('Session not in project');
    const { data, error } = await this.db
      .from('retro_items')
      .insert({ session_id: input.session_id, category: input.category, text: input.text, author_id: input.author_id })
      .select()
      .single();
    if (error) throw error;
    return data as RetroItemRecord;
  }

  async voteItem(itemId: string, voterId: string, projectId: string): Promise<{ voted: boolean }> {
    const { data: item } = await this.db
      .from('retro_items')
      .select('session_id')
      .eq('id', itemId)
      .single();
    if (!item) throw new Error('Item not found');
    const { data: sess } = await this.db
      .from('retro_sessions')
      .select('id')
      .eq('id', item.session_id as string)
      .eq('project_id', projectId)
      .single();
    if (!sess) throw new Error('Item not in project');
    const { error } = await this.db
      .from('retro_votes')
      .insert({ item_id: itemId, voter_id: voterId });
    if (error) {
      if (error.code === '23505') {
        throw Object.assign(new Error('Already voted on this item'), { code: 'CONFLICT' });
      }
      throw error;
    }
    return { voted: true };
  }

  async addAction(input: {
    session_id: string;
    project_id: string;
    title: string;
    assignee_id?: string | null;
  }): Promise<RetroActionRecord> {
    const { data: sess, error: sessErr } = await this.db
      .from('retro_sessions')
      .select('id')
      .eq('id', input.session_id)
      .eq('project_id', input.project_id)
      .single();
    if (sessErr || !sess) throw new Error('Session not in project');
    const { data, error } = await this.db
      .from('retro_actions')
      .insert({ session_id: input.session_id, title: input.title, assignee_id: input.assignee_id ?? null })
      .select()
      .single();
    if (error) throw error;
    return data as RetroActionRecord;
  }

  async exportSession(sessionId: string, projectId: string): Promise<{ markdown: string }> {
    const { data: sess, error: sessErr } = await this.db
      .from('retro_sessions')
      .select('title')
      .eq('id', sessionId)
      .eq('project_id', projectId)
      .single();
    if (sessErr || !sess) throw new Error('Session not in project');
    const { data: items } = await this.db
      .from('retro_items')
      .select('category, text, vote_count')
      .eq('session_id', sessionId)
      .order('vote_count', { ascending: false });
    const { data: actions } = await this.db
      .from('retro_actions')
      .select('title, status')
      .eq('session_id', sessionId)
      .order('created_at');

    let md = `# ${sess.title as string}\n\n`;
    for (const cat of ['good', 'bad', 'improve'] as RetroItemCategory[]) {
      const catItems = (items ?? []).filter((item) => item.category === cat);
      md += `## ${cat === 'good' ? '👍 Good' : cat === 'bad' ? '👎 Bad' : '💡 Improve'}\n`;
      for (const item of catItems) md += `- ${item.text as string} (${(item.vote_count as number) ?? 0} votes)\n`;
      md += '\n';
    }
    if ((actions ?? []).length) {
      md += '## 🎯 Actions\n';
      for (const action of actions ?? []) md += `- [${action.status as string}] ${action.title as string}\n`;
    }
    return { markdown: md };
  }
}
