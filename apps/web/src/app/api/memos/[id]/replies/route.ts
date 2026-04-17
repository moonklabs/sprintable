import { parseBody, createMemoReplySchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
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

    const parsed = await parseBody(request, createMemoReplySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    // API Key 인증시 RLS 우회를 위해 admin client 사용
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;
    const service = new MemoService(dbClient);
    const reply = await service.addReply(id, body.content, me.id);
    return apiSuccess(reply, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
