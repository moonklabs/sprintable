import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createProjectPermissionsRepository } from '@/lib/storage/factory';

// GET /api/members?project_id=X
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    // project_permissions 기반 read 권한 확인 (member_id 연결된 경우)
    const { data: tmData } = await dbClient
      .from('team_members')
      .select('member_id')
      .eq('id', me.id)
      .maybeSingle();

    if (tmData?.member_id) {
      const permRepo = await createProjectPermissionsRepository(dbClient);
      const hasRead = await permRepo.hasPermission(tmData.member_id, projectId, 'read');
      if (!hasRead) return ApiErrors.forbidden('Read permission required');
    }

    const { data, error } = await dbClient
      .from('team_members')
      .select('id, name, type, role, is_active')
      .eq('project_id', projectId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
