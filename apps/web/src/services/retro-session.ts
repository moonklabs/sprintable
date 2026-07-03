

export type RetroSessionPhase = 'collect' | 'group' | 'vote' | 'discuss' | 'action' | 'closed';
export type RetroItemCategory = 'good' | 'bad' | 'improve';

// B1(9f27af8f): 유나 phase-options-mockup B열 — 사용자 시야엔 3단계(+closed)만 노출.
// group/discuss는 독립 단계가 아니라 우선순위/액션 단계 내 비차단 도구로 흡수(레거시 세션 호환 매핑).
export type RetroVisibleStage = 'collect' | 'priority' | 'action' | 'closed';

export const RETRO_STAGE_ORDER: RetroVisibleStage[] = ['collect', 'priority', 'action', 'closed'];

export const RETRO_PHASE_TO_STAGE: Record<RetroSessionPhase, RetroVisibleStage> = {
  collect: 'collect',
  group: 'priority',
  vote: 'priority',
  discuss: 'action',
  action: 'action',
  closed: 'closed',
};

export const RETRO_STAGE_VARIANTS: Record<RetroVisibleStage, 'success' | 'info' | 'outline' | 'secondary'> = {
  collect: 'info',
  priority: 'secondary',
  action: 'success',
  closed: 'outline',
};

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
  // B4(9f27af8f, #1803 머지): 요청자 투표 여부 — 새로고침 후에도 투표 상태 복원.
  voted_by_me?: boolean;
  // B2(9f27af8f, #1804 머지): 'group' 도구 병합. child일 때만 non-null, top-level만 렌더 대상.
  parent_item_id?: string | null;
  // parent일 때 그 아래 병합된 child item id 목록(vote_count에 이미 합산 반영됨).
  grouped_item_ids?: string[];
}

export interface RetroActionRecord {
  id: string;
  session_id: string;
  title: string;
  assignee_id: string | null;
  status: string;
  created_at: string;
}

/**
 * E-SPRINT-LOOP FE(1b9f4ecb) — 회고 = sprint-close 종합 cockpit(핸드오프 `retro-sprint-close-synthesis-handoff`
 * §5). additive+nullable graceful 계약 — 소스=HypothesisSprintLink(BE story a4acc4d0, 디디 병행).
 * BE 미착지 구간엔 필드 부재/404를 빈배열·null로 흡수해 렌더(크래시 0, 별도 BE 대기 불요).
 */
export type RetroHypothesisVerdict = 'verified' | 'falsified' | 'measuring' | 'killed';

export interface RetroHypothesisResult {
  id: string;
  statement: string;
  status: RetroHypothesisVerdict;
  metric?: string | null;
  target?: number | null;
  direction?: 'up' | 'down' | null;
  actual?: number | null;
  measure_after?: string | null;
  href?: string | null;
}

export interface RetroSynthesisLearned {
  text: string;
  source?: string | null;
}

export interface RetroSynthesis {
  learned: RetroSynthesisLearned[];
  generated_at: string;
  source: 'ai_draft';
}

export interface RetroNextHypothesis {
  statement: string;
  // BE 계약 추정(§5 HypothesisDraftResponse 형) — 실제 페이로드에서 누락/null 가능성 있어
  // optional로 방어(까심 QA 적출: 무가드 deref 크래시 재발 방지).
  metric_definition?: { metric: string; target: number; direction: 'up' | 'down' } | null;
  measure_after?: string | null;
  confidence?: number | null;
  rationale?: string | null;
  requires_confirmation: true;
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
