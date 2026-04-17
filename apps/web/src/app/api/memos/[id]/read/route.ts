import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    // API Key 인증시 RLS 우회를 위해 admin client 사용
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new MemoService(dbClient);
    await service.markRead(id, me.id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
