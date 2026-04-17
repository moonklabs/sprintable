import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createMemoRepository, isOssMode } from '@/lib/storage/factory';
import type { SupabaseClient } from '@supabase/supabase-js';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': '300',
            'X-RateLimit-Remaining': String(me.rateLimitRemaining ?? 0),
            'X-RateLimit-Reset': String(me.rateLimitResetAt ?? 0),
          },
        }
      );
    }

    const dbClient = isOssMode() ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);
    const repo = await createMemoRepository(dbClient);
    const service = new MemoService(repo, dbClient as SupabaseClient | undefined);
    const memo = await service.getByIdWithDetails(id);

    // Agent scope 검증: cross-project 접근 차단
    if (me.type === 'agent' && memo.project_id !== me.project_id) {
      return ApiErrors.forbidden('Forbidden: cross-project access not allowed');
    }

    return apiSuccess(memo);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
