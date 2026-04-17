export interface AgentRun {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string | null;
  session_id: string | null;
  memo_id: string | null;
  story_id: string | null;
  trigger: string | null;
  status: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  result_summary: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface AgentRunListFilters {
  orgId: string;
  projectId: string;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit: number;
}

export interface AgentRunListResult {
  items: AgentRun[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface IAgentRunRepository {
  list(filters: AgentRunListFilters): Promise<AgentRunListResult>;
  getById(id: string, orgId: string, projectId: string): Promise<AgentRun | null>;
}
