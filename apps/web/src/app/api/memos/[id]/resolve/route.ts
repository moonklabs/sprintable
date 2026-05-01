import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createMemoRepository, isOssMode } from '@/lib/storage/factory';
import type { SupabaseClient } from '@supabase/supabase-js';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();

    const dbClient = isOssMode() ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createMemoRepository(dbClient);
    const service = new MemoService(repo, dbClient as SupabaseClient | undefined);
    const memo = await service.resolve(id, me.id);
    return apiSuccess(memo);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
