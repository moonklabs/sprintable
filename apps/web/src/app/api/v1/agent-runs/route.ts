import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { requireAgentOrchestration } from '@/lib/require-agent-orchestration';
import { normalizeRunStatusFilter } from '@/services/agent-run-history';

const PAGE_SIZE = 20;
const DEFAULT_DAYS = 7;

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const gateResponse = await requireAgentOrchestration(supabase, me.org_id);
    if (gateResponse) return gateResponse;

    const url = new URL(request.url);
    const status = normalizeRunStatusFilter(url.searchParams.get('status'));
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE_SIZE), 50);

    let query = supabase
      .from('agent_runs')
      .select('id, agent_id, deployment_id, session_id, memo_id, story_id, trigger, model, llm_provider, llm_provider_key, status, duration_ms, llm_call_count, input_tokens, output_tokens, cost_usd, computed_cost_cents, per_run_cap_cents, billing_notes, result_summary, last_error_code, error_message, retry_count, max_retries, next_retry_at, failure_disposition, started_at, finished_at, created_at')
      .eq('org_id', me.org_id)
      .eq('project_id', me.project_id)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (status) {
      query = query.eq('status', status);
    }

    const fromDate = from ?? new Date(Date.now() - DEFAULT_DAYS * 86400000).toISOString();
    query = query.gte('created_at', fromDate);

    if (to) {
      query = query.lte('created_at', to);
    }

    if (cursor) {
      query = query.lt('created_at', cursor);
    }

    const { data: runs, error } = await query;
    if (error) throw error;

    const items = runs ?? [];
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.created_at : null;

    // resolve agent names
    const agentIds = [...new Set(page.map((r) => r.agent_id as string).filter(Boolean))];
    let agentNameById: Record<string, string> = {};
    if (agentIds.length > 0) {
      const { data: agents } = await supabase
        .from('team_members')
        .select('id, name')
        .in('id', agentIds);
      agentNameById = Object.fromEntries((agents ?? []).map((a) => [a.id as string, a.name as string]));
    }

    const enriched = page.map((r) => ({
      ...r,
      agent_name: agentNameById[r.agent_id as string] ?? null,
    }));

    return apiSuccess(enriched, { nextCursor, hasMore, limit });
  } catch (error) {
    return handleApiError(error);
  }
}
