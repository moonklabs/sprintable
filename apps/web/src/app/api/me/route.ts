import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTeamMemberFromRequest } from '@/lib/auth-api-key';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';

export async function GET(request: Request) {
  if (isOssMode()) {
    const { OSS_MEMBER_ID } = await import('@sprintable/storage-sqlite');
    return apiSuccess({ id: OSS_MEMBER_ID, name: 'OSS User', type: 'human', role: 'owner', is_active: true, email: null });
  }
  try {
    const adminClient = createSupabaseAdminClient();
    const apiKeyMe = await getTeamMemberFromRequest(adminClient, request);
    if (apiKeyMe) {
      const { data: member, error } = await adminClient
        .from('team_members')
        .select('id, name, type, role, is_active')
        .eq('id', apiKeyMe.id)
        .maybeSingle();
      if (error) throw error;
      if (!member) return ApiErrors.notFound('Member not found');
      return apiSuccess({ ...member, email: null });
    }

    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const { data: member, error } = await supabase
      .from('team_members')
      .select('id, name, type, role, is_active')
      .eq('id', me.id)
      .maybeSingle();

    if (error) throw error;
    if (!member) return ApiErrors.notFound('Member not found');

    return apiSuccess({ ...member, email: user.email ?? null });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request) {
  if (isOssMode()) {
    const { OSS_MEMBER_ID } = await import('@sprintable/storage-sqlite');
    let body: unknown;
    try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
    const { name } = (body as Record<string, unknown>) ?? {};
    if (typeof name !== 'string' || !name.trim()) return apiError('VALIDATION_ERROR', 'name is required', 400);
    return apiSuccess({ id: OSS_MEMBER_ID, name: name.trim(), type: 'human', role: 'owner', is_active: true, email: null });
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    let body: unknown;
    try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
    if (!body || typeof body !== 'object') return apiError('BAD_REQUEST', 'Body must be an object', 400);

    const { name } = body as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) return apiError('VALIDATION_ERROR', 'name is required', 400);

    const { data, error } = await supabase
      .from('team_members')
      .update({ name: name.trim() })
      .eq('id', me.id)
      .select('id, name, type, role, is_active')
      .maybeSingle();

    if (error) throw error;
    return apiSuccess({ ...data, email: user.email ?? null });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
