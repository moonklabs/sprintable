
import type { SupabaseClient } from '@/types/supabase';
import { fastapiCall } from '@sprintable/storage-api';

// ─── Typed interfaces ────────────────────────────────────────────────────────

export interface ProjectOverview {
  sprints: { total: number; active: number };
  epics: number;
  stories: { total: number; done: number; total_points: number };
  tasks: number;
  memos: { total: number; open: number };
  members: { total: number; humans: number; agents: number };
}

export interface MemberWorkload {
  stories: { total: number; in_progress: number; points: number };
  tasks: { total: number; in_progress: number };
}

export interface SprintVelocity {
  id: string;
  title: string;
  velocity: number | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

export interface RecentActivity {
  recent_stories: Array<{ id: string; title: string; status: string; updated_at: string }>;
  recent_memos: Array<{ id: string; title: string; status: string; created_at: string }>;
  recent_agent_runs: Array<{ id: string; agent_id: string; trigger: string; status: string; created_at: string }>;
}

export interface EpicProgress {
  total_stories: number;
  done_stories: number;
  total_points: number;
  done_points: number;
  completion_pct: number;
}

export interface AgentStats {
  total_runs: number;
  completed: number;
  failed: number;
  total_tokens: number;
  total_cost_usd: number;
  avg_duration_ms: number;
}

export interface ProjectHealth {
  active_sprint: { id: string; title: string; start_date: string | null; end_date: string | null } | null;
  sprint_progress: number;
  open_memos: number;
  unassigned_stories: number;
  health: 'good' | 'warning';
}

// ─── Row shapes ───────────────────────────────────────────────────────────────

interface SprintRow { id: string; status: string; title?: string; velocity?: number | null; start_date?: string | null; end_date?: string | null }
interface StoryRow { id: string; status: string; story_points: number | null; title?: string; updated_at?: string }
interface TaskRow { id: string; status: string }
interface MemoRow { id: string; status: string; title?: string; created_at?: string }
interface MemberRow { id: string; type: string }
interface AgentRunRow { id: string; agent_id: string; trigger: string; status: string; created_at: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; duration_ms: number | null }

async function getSpAt(): Promise<string> {
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    return store.get('sp_at')?.value ?? '';
  } catch { return ''; }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class AnalyticsService {
  constructor(
    private readonly db: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private async getToken(): Promise<string> {
    return this.accessToken || await getSpAt();
  }

  async getOverview(projectId: string): Promise<ProjectOverview> {
    const token = await this.getToken();
    if (token) return fastapiCall<ProjectOverview>('GET', '/api/v2/analytics/overview', token, { query: { project_id: projectId } });
    const [sprints, epics, stories, tasks, memos, members] = await Promise.all([
      this.db.from('sprints').select('id, status').eq('project_id', projectId),
      this.db.from('epics').select('id').eq('project_id', projectId),
      this.db.from('stories').select('id, status, story_points').eq('project_id', projectId),
      this.db.from('tasks').select('id, status, stories!inner(project_id)').eq('stories.project_id', projectId),
      this.db.from('memos').select('id, status').eq('project_id', projectId),
      this.db.from('team_members').select('id, type').eq('project_id', projectId).eq('is_active', true),
    ]);
    const sprintRows = (sprints.data ?? []) as SprintRow[];
    const storyRows = (stories.data ?? []) as StoryRow[];
    const memoRows = (memos.data ?? []) as MemoRow[];
    const memberRows = (members.data ?? []) as MemberRow[];
    return {
      sprints: { total: sprintRows.length, active: sprintRows.filter((s) => s.status === 'active').length },
      epics: epics.data?.length ?? 0,
      stories: { total: storyRows.length, done: storyRows.filter((s) => s.status === 'done').length, total_points: storyRows.reduce((a, s) => a + (s.story_points ?? 0), 0) },
      tasks: tasks.data?.length ?? 0,
      memos: { total: memoRows.length, open: memoRows.filter((m) => m.status === 'open').length },
      members: { total: memberRows.length, humans: memberRows.filter((m) => m.type === 'human').length, agents: memberRows.filter((m) => m.type === 'agent').length },
    };
  }

  async getMemberWorkload(projectId: string, memberId: string): Promise<MemberWorkload> {
    const token = await this.getToken();
    if (token) return fastapiCall<MemberWorkload>('GET', '/api/v2/analytics/workload', token, { query: { project_id: projectId, member_id: memberId } });
    const [stories, tasks] = await Promise.all([
      this.db.from('stories').select('id, status, story_points').eq('project_id', projectId).eq('assignee_id', memberId),
      this.db.from('tasks').select('id, status, stories!inner(project_id)').eq('stories.project_id', projectId).eq('assignee_id', memberId),
    ]);
    const storyRows = (stories.data ?? []) as StoryRow[];
    const taskRows = (tasks.data ?? []) as TaskRow[];
    return {
      stories: { total: storyRows.length, in_progress: storyRows.filter((s) => s.status === 'in-progress').length, points: storyRows.reduce((a, s) => a + (s.story_points ?? 0), 0) },
      tasks: { total: taskRows.length, in_progress: taskRows.filter((t) => t.status === 'in-progress').length },
    };
  }

  async getVelocityHistory(projectId: string): Promise<SprintVelocity[]> {
    const token = await this.getToken();
    if (token) return fastapiCall<SprintVelocity[]>('GET', '/api/v2/analytics/velocity-history', token, { query: { project_id: projectId } });
    const { data, error } = await this.db.from('sprints').select('id, title, velocity, status, start_date, end_date').eq('project_id', projectId).eq('status', 'closed').order('end_date');
    if (error) throw new Error(error.message);
    return (data ?? []) as SprintVelocity[];
  }

  async getRecentActivity(projectId: string, limit = 10): Promise<RecentActivity> {
    const token = await this.getToken();
    if (token) return fastapiCall<RecentActivity>('GET', '/api/v2/analytics/activity', token, { query: { project_id: projectId, limit } });
    const [storiesResult, memosResult, runsResult] = await Promise.all([
      this.db.from('stories').select('id, title, status, updated_at').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(limit),
      this.db.from('memos').select('id, title, status, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(limit),
      (async () => {
        const { data: agents } = await this.db.from('team_members').select('id').eq('project_id', projectId).eq('type', 'agent');
        const ids = (agents ?? []).map((a: { id: string }) => a.id);
        if (ids.length === 0) return { data: [] as AgentRunRow[] };
        return this.db.from('agent_runs').select('id, agent_id, trigger, status, created_at').in('agent_id', ids).order('created_at', { ascending: false }).limit(limit);
      })(),
    ]);
    return {
      recent_stories: (storiesResult.data ?? []) as RecentActivity['recent_stories'],
      recent_memos: (memosResult.data ?? []) as RecentActivity['recent_memos'],
      recent_agent_runs: (runsResult.data ?? []) as RecentActivity['recent_agent_runs'],
    };
  }

  async getEpicProgress(projectId: string, epicId: string): Promise<EpicProgress> {
    const token = await this.getToken();
    if (token) return fastapiCall<EpicProgress>('GET', '/api/v2/analytics/epic-progress', token, { query: { project_id: projectId, epic_id: epicId } });
    const { data } = await this.db.from('stories').select('status, story_points').eq('project_id', projectId).eq('epic_id', epicId);
    const stories = (data ?? []) as StoryRow[];
    const total = stories.length;
    const done = stories.filter((s) => s.status === 'done').length;
    const totalPts = stories.reduce((a, s) => a + (s.story_points ?? 0), 0);
    const donePts = stories.filter((s) => s.status === 'done').reduce((a, s) => a + (s.story_points ?? 0), 0);
    return { total_stories: total, done_stories: done, total_points: totalPts, done_points: donePts, completion_pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }

  async getAgentStats(projectId: string, agentId: string): Promise<AgentStats> {
    const token = await this.getToken();
    if (token) return fastapiCall<AgentStats>('GET', '/api/v2/analytics/agent-stats', token, { query: { project_id: projectId, agent_id: agentId } });
    const mb = await this.db.from('team_members').select('id').eq('id', agentId).eq('project_id', projectId).eq('type', 'agent').single();
    if (mb.error) throw new Error('Agent not found in project');
    const { data } = await this.db.from('agent_runs').select('status, input_tokens, output_tokens, cost_usd, duration_ms').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(1000);
    const runs = (data ?? []) as AgentRunRow[];
    const completed = runs.filter((r) => r.status === 'completed');
    return {
      total_runs: runs.length,
      completed: completed.length,
      failed: runs.filter((r) => r.status === 'failed').length,
      total_tokens: completed.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0),
      total_cost_usd: completed.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
      avg_duration_ms: completed.length > 0 ? Math.round(completed.reduce((a, r) => a + (r.duration_ms ?? 0), 0) / completed.length) : 0,
    };
  }

  async getProjectHealth(projectId: string): Promise<ProjectHealth> {
    const token = await this.getToken();
    if (token) return fastapiCall<ProjectHealth>('GET', '/api/v2/analytics/health', token, { query: { project_id: projectId } });
    const [sprintResult, memosResult, unassignedResult] = await Promise.all([
      this.db.from('sprints').select('id, title, start_date, end_date').eq('project_id', projectId).eq('status', 'active').single(),
      this.db.from('memos').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'open'),
      this.db.from('stories').select('*', { count: 'exact', head: true }).eq('project_id', projectId).is('assignee_id', null).neq('status', 'done'),
    ]);
    const activeSprint = sprintResult.data;
    const openMemoCount = memosResult.count ?? 0;
    const unassignedCount = unassignedResult.count ?? 0;
    const stories = activeSprint ? await this.db.from('stories').select('status, story_points').eq('sprint_id', activeSprint.id) : { data: [] as StoryRow[] };
    const storyRows = (stories.data ?? []) as StoryRow[];
    const total = storyRows.length;
    const done = storyRows.filter((s) => s.status === 'done').length;
    return {
      active_sprint: activeSprint ?? null,
      sprint_progress: total > 0 ? Math.round((done / total) * 100) : 0,
      open_memos: openMemoCount,
      unassigned_stories: unassignedCount,
      health: openMemoCount > 10 || unassignedCount > 5 ? 'warning' : 'good',
    };
  }
}
