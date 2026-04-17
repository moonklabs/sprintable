import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';
import { parseBody, acceptInvitationSchema } from '@sprintable/shared';
import { isOssMode } from '@/lib/storage/factory';

/** POST — 초대 수락 (SECURITY DEFINER RPC로 RLS 우회) */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Invitations are not supported in OSS mode.', 501);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, acceptInvitationSchema);
    if (!parsed.success) return parsed.response;
    const { token } = parsed.data;

    const { data, error } = await supabase.rpc('accept_invitation', { _token: token });

    if (error) {
      if (error.message.includes('expired')) return apiError('INVITATION_EXPIRED', error.message, 400);
      if (error.message.includes('mismatch')) return apiError('EMAIL_MISMATCH', error.message, 403);
      if (error.message.includes('not found')) return ApiErrors.notFound(error.message);
      throw error;
    }

    const acceptedProjectId = typeof data === 'object' && data !== null && 'project_id' in data
      ? (data as { project_id?: string | null }).project_id
      : null;

    if (acceptedProjectId) {
      const cookieStore = await cookies();
      cookieStore.set(CURRENT_PROJECT_COOKIE, acceptedProjectId, {
        path: '/',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 365,
      });
    }

    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
