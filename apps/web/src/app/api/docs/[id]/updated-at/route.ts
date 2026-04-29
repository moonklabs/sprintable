import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — updated_at 타임스탬프만 반환 (충돌 감지 경량 폴링용) */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const repo = await createDocRepository();
      const doc = await repo.getById(id);
      return apiSuccess({ updated_at: doc.updated_at });
    }

    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const { data, error } = await dbClient
      .from('docs')
      .select('updated_at')
      .eq('id', id)
      .eq('project_id', me.project_id)
      .single();

    if (error || !data) return ApiErrors.notFound();
    return apiSuccess({ updated_at: (data as { updated_at: string }).updated_at });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
