import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

// GET /api/dashboard?member_id=X[&project_id=X]
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const memberId = searchParams.get('member_id');
    if (!memberId) return ApiErrors.badRequest('member_id required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    // project_id가 없으면 member 소속 프로젝트로 자동 결정
    let projectId = searchParams.get('project_id');
    if (!projectId) {
      const { data: member } = await dbClient
        .from('team_members')
        .select('project_id')
        .eq('id', memberId)
        .eq('is_active', true)
        .single();
      if (!member) return ApiErrors.notFound('Member not found');
      projectId = member.project_id as string;
    }

    const [storiesRes, tasksRes, memosRes] = await Promise.all([
      dbClient.from('stories').select('id, title, status, story_points').eq('project_id', projectId).eq('assignee_id', memberId).neq('status', 'done'),
      dbClient.from('tasks').select('id, title, status').eq('assignee_id', memberId).neq('status', 'done'),
      dbClient.from('memos').select('id, title, status').eq('project_id', projectId).eq('assigned_to', memberId).eq('status', 'open'),
    ]);

    return apiSuccess({
      my_stories: storiesRes.data ?? [],
      assigned_stories: storiesRes.data ?? [],
      my_tasks: tasksRes.data ?? [],
      open_memos: memosRes.data ?? [],
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
