import type { SupabaseClient } from '@supabase/supabase-js';

export type RetroPhase = 'collect' | 'vote' | 'discuss' | 'action' | 'closed';
export type RetroCategory = 'good' | 'bad' | 'improve';
export type ActionStatus = 'open' | 'done';

export interface RetroSession {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  sprint_id: string | null;
  phase: string;
  created_by: string;
  created_at: string;
}

export interface RetroItem {
  id: string;
  session_id: string;
  category: string;
  text: string;
  vote_count: number;
  author_id: string;
  created_at: string;
}

export interface RetroAction {
  id: string;
  session_id: string;
  title: string;
  assignee_id: string | null;
  status: string;
  created_at: string;
}

export interface RetroExport {
  markdown: string;
}

export class RetroService {
  constructor(private readonly supabase: SupabaseClient) {}

  async getSessions(projectId: string): Promise<RetroSession[]> {
    const { data, error } = await this.supabase
      .from('retro_sessions')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as RetroSession[];
  }

  async getSession(id: string): Promise<RetroSession> {
    const { data, error } = await this.supabase
      .from('retro_sessions')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data as RetroSession;
  }

  async getSessionBySprintId(projectId: string, sprintId: string): Promise<RetroSession | null> {
    const { data } = await this.supabase
      .from('retro_sessions')
      .select('*')
      .eq('project_id', projectId)
      .eq('sprint_id', sprintId)
      .order('created_at', { ascending: false })
      .limit(1);
    return (data?.[0] as RetroSession) ?? null;
  }

  async createSession(input: {
    org_id: string;
    project_id: string;
    sprint_id?: string | null;
    title: string;
    created_by: string;
  }): Promise<RetroSession> {
    const { data, error } = await this.supabase
      .from('retro_sessions')
      .insert(input)
      .select()
      .single();
    if (error) throw error;
    return data as RetroSession;
  }

  async getOrCreateBySprintId(
    projectId: string,
    orgId: string,
    sprintId: string,
    initiatorId?: string,
  ): Promise<RetroSession> {
    const existing = await this.getSessionBySprintId(projectId, sprintId);
    if (existing) return existing;
    if (!initiatorId) throw new Error('No retro found. Provide initiator_id to create one.');
    const sprint = await this.supabase
      .from('sprints')
      .select('title')
      .eq('id', sprintId)
      .eq('project_id', projectId)
      .single();
    const title = `Retro: ${(sprint.data?.title as string) ?? sprintId}`;
    return this.createSession({ org_id: orgId, project_id: projectId, sprint_id: sprintId, title, created_by: initiatorId });
  }

  async changePhase(id: string, phase: RetroPhase): Promise<RetroSession> {
    const { data, error } = await this.supabase
      .from('retro_sessions')
      .update({ phase })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as RetroSession;
  }

  async changePhaseBySprintId(projectId: string, sprintId: string, phase: RetroPhase): Promise<RetroSession> {
    const session = await this.getSessionBySprintId(projectId, sprintId);
    if (!session) throw new Error('Retro session not found for sprint');
    return this.changePhase(session.id, phase);
  }

  async getItems(sessionId: string): Promise<RetroItem[]> {
    const { data, error } = await this.supabase
      .from('retro_items')
      .select('*')
      .eq('session_id', sessionId)
      .order('vote_count', { ascending: false });
    if (error) throw error;
    return (data ?? []) as RetroItem[];
  }

  async addItem(input: {
    session_id: string;
    category: RetroCategory;
    text: string;
    author_id: string;
  }): Promise<RetroItem> {
    const { data, error } = await this.supabase
      .from('retro_items')
      .insert(input)
      .select()
      .single();
    if (error) throw error;
    return data as RetroItem;
  }

  async addItemBySprintId(
    projectId: string,
    sprintId: string,
    category: RetroCategory,
    text: string,
    authorId: string,
  ): Promise<RetroItem> {
    const session = await this.getSessionBySprintId(projectId, sprintId);
    if (!session) throw new Error('Retro session not found for sprint');
    return this.addItem({ session_id: session.id, category, text, author_id: authorId });
  }

  async vote(itemId: string, _voterId: string): Promise<RetroItem> {
    const { data: current } = await this.supabase
      .from('retro_items')
      .select('vote_count')
      .eq('id', itemId)
      .single();
    const newCount = ((current?.vote_count as number) ?? 0) + 1;
    const { data, error } = await this.supabase
      .from('retro_items')
      .update({ vote_count: newCount })
      .eq('id', itemId)
      .select()
      .single();
    if (error) throw error;
    return data as RetroItem;
  }

  async getActions(sessionId: string): Promise<RetroAction[]> {
    const { data, error } = await this.supabase
      .from('retro_actions')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at');
    if (error) throw error;
    return (data ?? []) as RetroAction[];
  }

  async addAction(input: {
    session_id: string;
    title: string;
    assignee_id?: string | null;
  }): Promise<RetroAction> {
    const { data, error } = await this.supabase
      .from('retro_actions')
      .insert(input)
      .select()
      .single();
    if (error) throw error;
    return data as RetroAction;
  }

  async addActionBySprintId(
    projectId: string,
    sprintId: string,
    title: string,
    assigneeId: string,
  ): Promise<RetroAction> {
    const session = await this.getSessionBySprintId(projectId, sprintId);
    if (!session) throw new Error('Retro session not found for sprint');
    return this.addAction({ session_id: session.id, title, assignee_id: assigneeId });
  }

  async updateActionStatus(id: string, status: ActionStatus): Promise<RetroAction> {
    const { data, error } = await this.supabase
      .from('retro_actions')
      .update({ status })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as RetroAction;
  }

  async exportSession(sessionId: string): Promise<RetroExport> {
    const { data: session } = await this.supabase
      .from('retro_sessions')
      .select('title')
      .eq('id', sessionId)
      .single();
    if (!session) throw new Error('Session not found');

    const items = await this.getItems(sessionId);
    const actions = await this.getActions(sessionId);

    let md = `# ${session.title as string}\n\n`;
    for (const cat of ['good', 'bad', 'improve'] as RetroCategory[]) {
      const catItems = items.filter((item) => item.category === cat);
      md += `## ${cat === 'good' ? '👍 Good' : cat === 'bad' ? '👎 Bad' : '💡 Improve'}\n`;
      for (const item of catItems) {
        md += `- ${item.text} (${item.vote_count ?? 0} votes)\n`;
      }
      md += '\n';
    }
    if (actions.length) {
      md += '## 🎯 Actions\n';
      for (const action of actions) {
        md += `- [${action.status}] ${action.title}\n`;
      }
    }
    return { markdown: md };
  }

  async exportBySprintId(projectId: string, sprintId: string): Promise<RetroExport> {
    const session = await this.getSessionBySprintId(projectId, sprintId);
    if (!session) throw new Error('Retro session not found for sprint');
    return this.exportSession(session.id);
  }
}
